import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  TabCloseRequest,
  TabOpenRequest,
  TabRequestAnswer,
  TextReviewAnswer,
  TextReviewRequest
} from '@shared/types'
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

/**
 * How long Claude Code lets a call to this server run. `review_text` waits for the user,
 * who may be at lunch. Without it a stdio server's call is cut off after 30 minutes
 * without an answer (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, raised to this by the server's
 * `timeout`) — read out of the 2.1.318 binary, where the field is documented as the
 * per-server tool-call timeout.
 */
const CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * How long the renderer has to confirm it shows a review. One sent while it is loading is
 * dropped by `send`, and the call would wait for nobody until the timeout above.
 */
const REVIEW_ACK_MS = 5000

interface Review {
  settle: (answer: TextReviewAnswer | undefined) => void
  ack?: NodeJS.Timeout
}

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
 *
 * The third tool, `review_text`, is not about tabs: it holds a text the session means to
 * post until the user has decided on it in the tab's review panel — `review`
 * (TextReviewRequest), acknowledged through `acknowledgeReview` and answered through
 * `answerReview`, or `review-closed` (reviewId) when the call went away first: Esc in the
 * terminal, which makes Claude Code cancel it, or the session ending.
 */
export class TabSpawnServer extends EventEmitter {
  private server?: Server
  private readonly pending = new Map<string, (answer: TabRequestAnswer) => void>()
  private readonly reviews = new Map<string, Review>()
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
    // `failAll` gives every open review back as no decision, which is what a quitting aterm means.
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
          env: { ELECTRON_RUN_AS_NODE: '1' },
          timeout: CALL_TIMEOUT_MS
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
    for (const reviewId of [...this.reviews.keys()]) this.answerReview(reviewId, { kind: 'pass' })
  }

  /** The renderer shows the review and will answer it. */
  acknowledgeReview(reviewId: string): void {
    const review = this.reviews.get(reviewId)
    if (!review?.ack) return
    clearTimeout(review.ack)
    review.ack = undefined
  }

  answerReview(reviewId: string, answer: TextReviewAnswer): void {
    const review = this.reviews.get(reviewId)
    this.reviews.delete(reviewId)
    if (review?.ack) clearTimeout(review.ack)
    review?.settle(answer)
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    let taken = false
    // What to do if the caller hangs up before the answer: Claude Code cancelled the call.
    let onGone: (() => void) | undefined
    let answered = false
    socket.on('data', (chunk: string) => {
      if (taken) return
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) {
        if (buffer.length > MAX_REQUEST) socket.destroy()
        return
      }
      taken = true
      const finish = (reply: Reply): void => {
        answered = true
        if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`)
      }
      void this.handle(buffer.slice(0, end), (cb) => (onGone = cb)).then(finish, (err: unknown) =>
        finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
      )
    })
    socket.on('close', () => {
      if (!answered) onGone?.()
    })
    socket.on('error', () => {
      // The server went away mid-call; `close` follows.
    })
  }

  private async handle(line: string, onGone: (cb: () => void) => void): Promise<Reply> {
    const call = parseCall(line)
    if (!call) return { ok: false, error: 'Malformed request.' }
    if (call.tool === 'open_tab') {
      const next = this.opening.then(() => this.open(call))
      this.opening = next.catch(() => undefined)
      return next
    }
    if (call.tool === 'close_tab') return this.close(call)
    if (call.tool === 'review_text') return this.review(call, onGone)
    return { ok: false, error: `Unknown tool ${call.tool}.` }
  }

  /**
   * Holds the call until the user has decided. Nothing is posted from here: the answer
   * tells Claude what to do, and an approval hands back the exact text to post, because
   * the user may have edited it.
   */
  private review(call: Call, onGone: (cb: () => void) => void): Promise<Reply> {
    const { args } = call
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text.trim()) return Promise.resolve({ ok: false, error: 'text must not be empty.' })
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Text'
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    if (!target) return Promise.resolve({ ok: false, error: 'target must say where the text is going.' })

    const request: TextReviewRequest = { reviewId: randomUUID(), tabId: call.tabId, title, target, text }
    return new Promise((done) => {
      const review: Review = {
        settle: (answer) => done(reviewReply(answer)),
        ack: setTimeout(() => {
          this.reviews.delete(request.reviewId)
          review.settle(undefined)
        }, REVIEW_ACK_MS)
      }
      this.reviews.set(request.reviewId, review)
      onGone(() => {
        if (!this.reviews.has(request.reviewId)) return
        this.reviews.delete(request.reviewId)
        if (review.ack) clearTimeout(review.ack)
        this.emit('review-closed', request.reviewId)
      })
      this.emit('review', request)
    })
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
    const title = typeof args.title === 'string' ? sessionName(args.title) : ''
    if (!title) return { ok: false, error: 'title must name the task in a few words.' }

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

    const started = await this.waitForStart(answer.tabId, answer.claudeSessionId, title)
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
        ? `The session works with the user and will message you with SendMessage when its task is done. Message it as "${child.name}" - by that name, never by the uds: address its messages come from: that address belongs to one process and is gone once the session is resumed, as every tab is when aterm restarts.`
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
   * Waits until the new session shows up in Claude Code's registry under the name it was
   * started with — or until its process ends without ever getting there. Gives up after
   * `REGISTRY_TIMEOUT_MS` with whatever the registry says by then, which is not a failure:
   * a folder Claude Code has not been trusted in yet holds the session at that question.
   *
   * The first name the registry shows is not the one: it registers under a name derived
   * from the directory (`ccam2-87`) and takes `--name` a moment later. A caller handed
   * that first name found no session by it, and fell back on the address of the child's
   * process instead, which was gone after the next restart of aterm.
   */
  private async waitForStart(
    tabId: string,
    sessionId: string | undefined,
    name: string
  ): Promise<{ session?: LiveSession } | { ended: EndedProcess }> {
    const deadline = Date.now() + REGISTRY_TIMEOUT_MS
    for (;;) {
      const session = sessionId ? findLiveSession(sessionId) : undefined
      if (session?.name === name) return { session }
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

/**
 * What Claude is told of the user's decision. An approval repeats the text whole, between
 * markers, even when it is unchanged: "post exactly this" leaves no room for a draft Claude
 * still has in mind. No answer at all — the renderer never took the review — is an error,
 * so Claude falls back on asking in the terminal.
 */
function reviewReply(answer: TextReviewAnswer | undefined): Reply {
  if (!answer) {
    return { ok: false, error: 'aterm could not show the review. Ask the user in the terminal instead.' }
  }
  switch (answer.kind) {
    case 'approve':
      return {
        ok: true,
        text: [
          answer.edited
            ? 'APPROVED WITH EDITS. The user edited the text and approved their version. Post exactly the text between the markers, unchanged - not your own draft.'
            : 'APPROVED. Post exactly the text between the markers, unchanged.',
          '<<<TEXT',
          answer.text,
          'TEXT>>>'
        ].join('\n')
      }
    case 'revise':
      return { ok: true, text: `CHANGES REQUESTED. Do not post anything yet.\n\n${answer.feedback}` }
    case 'reject':
      return {
        ok: true,
        text:
          'REJECTED. The user does not want this text posted. Do not post it, and do not post a revised version unless the user asks for one.' +
          (answer.reason ? `\n\nTheir reason:\n${answer.reason}` : '')
      }
    case 'pass':
      return {
        ok: true,
        text: 'NO DECISION. The user closed the review without deciding. Do not post the text; ask them in the terminal how to go on.'
      }
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
 * The task as the new session gets it, through a file it is asked to read (`claudeLaunch`).
 * The Read result keeps it in the transcript, so a resumed session still knows who it
 * reports to. The session is told outright that it works with the user, because the
 * obvious reading of a delegated task is to finish it in one reply and report.
 *
 * One that starts with a dash gets a line in front, a leftover from when it was a
 * command-line argument.
 */
function handOver(task: string, parentName: string | undefined): string {
  const parent = parentName ? `the Claude Code session "${parentName}"` : 'another Claude Code session'
  const body = task.trim()
  return [
    body.startsWith('-') ? `Task:\n${body}` : body,
    '',
    '---',
    `You were opened from aterm by ${parent}. Work on this together with the user in this terminal; it may take many turns. Do not report back after your first reply unless the task is really finished. When it is done, or the user asks you to, send a concise result to ${parentName ? `"${parentName}"` : 'that session'} with SendMessage, by that name and never by the uds: address its messages come from, which is gone once that session is resumed (ListAgents finds it if the name is gone). You may message it earlier when you need something only it knows.`
  ].join('\n')
}

/**
 * The title as `claude --name` gets it. Unlike the task it does go onto the command line,
 * so it is cut down to words: endpoint protection reads command lines (`promptFileArg`),
 * and a `::` was enough to get aterm killed. cmd.exe, which runs a `claude.cmd`, would
 * also act on `&`, `|` and the like.
 */
function sessionName(title: string): string {
  return title
    .replace(/[^\p{L}\p{N} .,'_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,'_-]+/, '')
    .slice(0, 60)
    .trim()
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
