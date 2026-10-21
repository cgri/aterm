import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import type { TabCloseRequest, TabOpenRequest, TabRequestAnswer } from '@shared/types'
import {
  findLiveSession,
  listLiveSessions,
  readLiveSession,
  type LiveSession
} from '../claude/sessionRegistry'
import type { EndedProcess } from '../pty/PtyManager'
import { hasChanges, workingTreeRoot } from '../util/git'

/** A call larger than this is not one of ours, and the connection is dropped. */
const MAX_REQUEST = 1024 * 1024

/**
 * How long the renderer has to make or close a tab. Starting one is a round trip and a
 * spawn; a renderer that has not answered by then is loading, or gone.
 */
const ANSWER_TIMEOUT_MS = 15_000

/**
 * How long `open_tab` waits for the new session to show up in Claude Code's registry,
 * which is what its name comes from. A folder Claude Code has not been trusted in yet
 * holds the session at that question, so this has to give up at some point.
 */
const REGISTRY_TIMEOUT_MS = 20_000

type Isolation = 'auto' | 'worktree' | 'inplace'

interface Call {
  /** The tab the calling session runs in — from its own MCP config, not from the environment. */
  tabId: string
  /** The `claude` process that started the MCP server, which is the calling session. */
  ppid?: number
  tool: string
  args: Record<string, unknown>
}

/** What goes back to the MCP server: text for Claude, or an error it is shown as such. */
type Reply = { ok: true; text: string } | { ok: false; error: string }

/** What the server needs to know about the tabs' processes. */
export interface TabProcesses {
  /** The directory every running tab started in, by tab id. */
  dirs(): Map<string, string>
  /** How a tab's process ended, if it has. */
  ended(tabId: string): EndedProcess | undefined
}

/**
 * The aterm end of the `aterm` MCP server Claude sessions are started with
 * (`resources/aterm-tabs-mcp.js`). It lets a session open a tab with a session of its own,
 * and close one it opened. Nothing else: sessions find and message each other with Claude
 * Code's own `ListAgents` and `SendMessage`, and aterm stays out of that.
 *
 * Every tab gets an MCP config of its own that names the tab, rather than the server
 * reading `ATERM_TAB_ID` from its environment — what environment Claude Code hands an MCP
 * server is its business.
 *
 * Tabs belong to the renderer, so this only decides what main can decide — the directory,
 * the isolation, the prompt — and hands the rest over: `open` (TabOpenRequest) and `close`
 * (TabCloseRequest), each answered once through `answer`.
 */
export class TabSpawnServer extends EventEmitter {
  private server?: Server
  private readonly pending = new Map<string, (answer: TabRequestAnswer) => void>()
  /** Per process, so a dev run and the installed app each get their own pipe. */
  private readonly pipeName = `aterm-tabs-${process.pid}`
  private readonly configDir: string
  /**
   * Opens run one after the other. Claude may call the tool several times at once, and
   * two calls for the same clean repository would each find it free and both start in it.
   */
  private opening: Promise<unknown> = Promise.resolve()

  constructor(
    userData: string,
    private readonly serverScript: string,
    private readonly tabs: TabProcesses
  ) {
    super()
    this.configDir = join(userData, 'runtime', 'mcp')
  }

  /** Opens the pipe. False when it could not be opened — the tabs then start without the tools. */
  start(): Promise<boolean> {
    return new Promise((done) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', () => done(false))
      server.listen(`\\\\.\\pipe\\${this.pipeName}`, () => {
        this.server = server
        try {
          rmSync(this.configDir, { recursive: true, force: true })
          mkdirSync(this.configDir, { recursive: true })
          done(true)
        } catch {
          done(false)
        }
      })
    })
  }

  stop(): void {
    this.failAll('aterm is shutting down.')
    this.server?.close()
    this.server = undefined
  }

  /** The `--mcp-config` file for one tab, written on demand. Undefined without a pipe. */
  configFor(tabId: string): string | undefined {
    if (!this.server) return undefined
    const file = join(this.configDir, `${tabId}.json`)
    const config = {
      mcpServers: {
        aterm: {
          type: 'stdio',
          // aterm's own executable, run as plain Node: no Node installation is needed.
          command: process.execPath,
          args: [this.serverScript, '--pipe', this.pipeName, '--tab', tabId],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }
    }
    try {
      writeFileSync(file, JSON.stringify(config, null, 2))
      return file
    } catch {
      return undefined
    }
  }

  /** The renderer's answer to an `open` or `close` it was handed. */
  answer(requestId: string, answer: TabRequestAnswer): void {
    const settle = this.pending.get(requestId)
    this.pending.delete(requestId)
    settle?.(answer)
  }

  /** Everything open goes back unanswered — the renderer that held it is gone. */
  failAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) this.answer(requestId, { ok: false, error: reason })
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    let taken = false
    socket.on('data', (chunk: string) => {
      if (taken) return
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) {
        if (buffer.length > MAX_REQUEST) socket.destroy()
        return
      }
      taken = true
      void this.handle(buffer.slice(0, end)).then(
        (reply) => socket.end(`${JSON.stringify(reply)}\n`),
        (err: unknown) =>
          socket.end(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`)
      )
    })
    socket.on('error', () => {
      // The server went away mid-call; nothing to answer.
    })
  }

  private async handle(line: string): Promise<Reply> {
    const call = parseCall(line)
    if (!call) return { ok: false, error: 'Malformed request.' }
    if (call.tool === 'open_tab') {
      const next = this.opening.then(() => this.open(call))
      this.opening = next.catch(() => undefined)
      return next
    }
    if (call.tool === 'close_tab') return this.close(call)
    return { ok: false, error: `Unknown tool ${call.tool}.` }
  }

  private async open(call: Call): Promise<Reply> {
    const { args } = call
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
      return { ok: false, error: 'cwd must be an absolute path.' }
    }
    const cwd = resolve(args.cwd)
    if (!isDirectory(cwd)) return { ok: false, error: `${cwd} is not a directory.` }
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
      return { ok: false, error: 'prompt must not be empty.' }
    }
    const isolation = (args.isolation ?? 'auto') as Isolation
    if (!['auto', 'worktree', 'inplace'].includes(isolation)) {
      return { ok: false, error: 'isolation must be auto, worktree or inplace.' }
    }
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined

    const root = await workingTreeRoot(cwd)
    if (isolation === 'worktree' && !root) {
      return { ok: false, error: `${cwd} is not in a git repository, so it cannot get a worktree.` }
    }
    const worktree =
      isolation === 'worktree' || (isolation === 'auto' && root !== undefined && (await this.occupied(cwd, root)))

    const parent = call.ppid ? readLiveSession(call.ppid) : undefined
    const answer = await this.ask<TabOpenRequest>('open', {
      requestId: randomUUID(),
      parentTabId: call.tabId,
      cwd,
      prompt: handOver(args.prompt, parent?.name),
      worktree,
      title
    })
    if (!answer.ok) return { ok: false, error: answer.error }

    const started = await this.waitForStart(answer.tabId, answer.claudeSessionId)
    if ('ended' in started) {
      // A tab whose session never got going would start again on the next click without
      // its task or its worktree — those belong to the first start. It goes.
      await this.ask<TabCloseRequest>('close', {
        requestId: randomUUID(),
        parentTabId: call.tabId,
        tabId: answer.tabId
      })
      return {
        ok: false,
        error: `The session ended right after it started (exit code ${started.ended.exitCode}), so the tab was closed again. It said:\n${lastLines(started.ended.head)}`
      }
    }
    const child = started.session
    const result = {
      tabId: answer.tabId,
      sessionName: child?.name ?? null,
      cwd: child?.cwd || cwd,
      isolation: worktree ? 'worktree' : 'inplace',
      note: child?.name
        ? `The session works with the user and will message you with SendMessage when its task is done. Message it as "${child.name}".`
        : 'The tab is open, but Claude Code asks something there before the session starts - usually whether to trust the folder. The tab is marked as waiting for the user; tell them. Find the session with ListAgents once it has started.'
    }
    return { ok: true, text: JSON.stringify(result, null, 2) }
  }

  private async close(call: Call): Promise<Reply> {
    if (typeof call.args.tabId !== 'string') return { ok: false, error: 'tabId is required.' }
    const answer = await this.ask<TabCloseRequest>('close', {
      requestId: randomUUID(),
      parentTabId: call.tabId,
      tabId: call.args.tabId
    })
    return answer.ok ? { ok: true, text: `Closed tab ${answer.tabId}.` } : { ok: false, error: answer.error }
  }

  /**
   * Would a session started in place here share its working tree with someone? With
   * changes nobody has committed, or with another session — Claude's anywhere, a shell
   * tab's in aterm — that runs in the same working tree, the caller's own included.
   */
  private async occupied(cwd: string, root: string): Promise<boolean> {
    if (await hasChanges(cwd)) return true
    const dirs = new Set([...listLiveSessions().map((s) => s.cwd), ...this.tabs.dirs().values()])
    for (const dir of dirs) {
      if (dir && (await workingTreeRoot(dir)) === root) return true
    }
    return false
  }

  /**
   * Waits until the new session shows up in Claude Code's registry, which is where its
   * name comes from — or until its process ends without ever getting there. Gives up
   * after `REGISTRY_TIMEOUT_MS` with no session, which is not a failure: a folder Claude
   * Code has not been trusted in yet holds the session at that question.
   */
  private async waitForStart(
    tabId: string,
    sessionId: string | undefined
  ): Promise<{ session?: LiveSession } | { ended: EndedProcess }> {
    const deadline = Date.now() + REGISTRY_TIMEOUT_MS
    for (;;) {
      const session = sessionId ? findLiveSession(sessionId) : undefined
      if (session?.name) return { session }
      const ended = this.tabs.ended(tabId)
      if (ended) return { ended }
      if (Date.now() >= deadline) return { session }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  private ask<T extends { requestId: string }>(event: 'open' | 'close', request: T): Promise<TabRequestAnswer> {
    return new Promise((done) => {
      const timer = setTimeout(
        () => this.answer(request.requestId, { ok: false, error: 'aterm did not answer in time.' }),
        ANSWER_TIMEOUT_MS
      )
      this.pending.set(request.requestId, (answer) => {
        clearTimeout(timer)
        done(answer)
      })
      this.emit(event, request)
    })
  }
}

function parseCall(line: string): Call | undefined {
  try {
    const data = JSON.parse(line) as Partial<Call>
    if (typeof data.tabId !== 'string' || typeof data.tool !== 'string') return undefined
    const args = data.args && typeof data.args === 'object' ? data.args : {}
    const ppid = typeof data.ppid === 'number' ? data.ppid : undefined
    return { tabId: data.tabId, ppid, tool: data.tool, args }
  } catch {
    return undefined
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The task as the new session gets it. It is the first prompt, so it stays in the
 * transcript and a resumed session still knows who it reports to. The session is told
 * outright that it works with the user, because the obvious reading of a delegated task
 * is to finish it in one reply and report.
 *
 * The task comes first, because Claude Code names the session — and with it the tab —
 * after its first prompt. One that starts with a dash would be taken for an option on the
 * command line, so it gets a line in front.
 */
function handOver(task: string, parentName: string | undefined): string {
  const parent = parentName ? `the Claude Code session "${parentName}"` : 'another Claude Code session'
  const body = task.trim()
  return [
    body.startsWith('-') ? `Task:\n${body}` : body,
    '',
    '---',
    `You were opened from aterm by ${parent}. Work on this together with the user in this terminal; it may take many turns. Do not report back after your first reply unless the task is really finished. When it is done, or the user asks you to, send a concise result to ${parentName ? `"${parentName}"` : 'that session'} with SendMessage (ListAgents finds it if that name is gone). You may message it earlier when you need something only it knows.`
  ].join('\n')
}

/** The last few lines a terminal showed, as plain text. */
function lastLines(output: string): string {
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[@-~]/g, '')
    .replace(/\x1b[=>()][0-9A-Za-z]?/g, '')
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(-6).join('\n') || '(nothing)'
}
