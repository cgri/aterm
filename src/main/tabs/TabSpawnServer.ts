import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import {
  TAB_NOTE_SEVERITIES,
  type ControlAnswer,
  type ControlRequest,
  type TabCloseRequest,
  type TabNote,
  type TabNoteSeverity,
  type TabOpenRequest,
  type TabRequestAnswer,
  type TextReviewAnswer,
  type TextReviewRequest
} from '@shared/types'
import {
  findLiveSession,
  listLiveSessions,
  readLiveSession,
  type LiveSession
} from '../claude/sessionRegistry'
import { conversationCwd } from '../claude/transcripts'
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
 * The same for a session started with `--worktree`, which registers only once
 * `git worktree add` is done — minutes in a large repository. No question holds it up:
 * without trust, `--worktree` exits at once. Given up on after 20 s, the tab was reported
 * as asking something; its process then ended, and the next click restarted it as an
 * empty session in the main checkout, without its task and its worktree.
 */
const WORKTREE_TIMEOUT_MS = 15 * 60_000

/** A tab `open_tab` has started, and what the call still needs to report on it. */
interface Opened {
  tabId: string
  claudeSessionId?: string
  cwd: string
  worktree: boolean
  title: string
}

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

/**
 * The calls an outside tool makes — a dashboard, a deploy watcher — rather than a session
 * in a tab. The caller is no tab, so these take none, and an empty `tabId` is fine.
 */
const CONTROL_TOOLS = new Set(['set_tab_status', 'focus_tab', 'list_sessions'])

/** A note is one line, not prose; anything longer is cut. */
const MAX_NOTE_LENGTH = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Call {
  /**
   * The tab the calling session runs in — from its own MCP config, not from the
   * environment. Empty for a `CONTROL_TOOLS` call, whose caller is no tab.
   */
  tabId: string
  /** The `claude` process that started the MCP server, which is the calling session. */
  ppid?: number
  tool: string
  args: Record<string, unknown>
}

/**
 * What goes back to the MCP server: text for Claude, or an error it is shown as such. A
 * `CONTROL_TOOLS` call gets data fields instead of text, and an error may carry a `code`.
 */
type Reply =
  | { ok: true; text: string }
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; code?: string }

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
 *
 * The same pipe takes three calls from outside tools, which are no tab and are offered as
 * no MCP tool (`CONTROL_TOOLS`): `set_tab_status` pins a one-line note to a session's tab,
 * `focus_tab` brings that tab to the front, and `list_sessions` says which sessions run
 * and in which tab. Each goes to the renderer as `control` (ControlRequest), answered
 * through `answerControl`; `reveal` asks for the window to come forward. None of them
 * ever writes to a terminal: a note is something the user sees when looking, and must not
 * reach the session.
 */
export class TabSpawnServer extends EventEmitter {
  private server?: Server
  private readonly pending = new Map<string, (answer: TabRequestAnswer) => void>()
  private readonly reviews = new Map<string, Review>()
  private readonly controls = new Map<string, (answer: ControlAnswer) => void>()
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

  /** The renderer's answer to a `control` request. */
  answerControl(requestId: string, answer: ControlAnswer): void {
    const settle = this.controls.get(requestId)
    this.controls.delete(requestId)
    settle?.(answer)
  }

  /** Everything open goes back unanswered — the renderer that held it is gone. */
  failAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) this.answer(requestId, { ok: false, error: reason })
    for (const requestId of [...this.controls.keys()]) this.answerControl(requestId, { ok: false, error: reason })
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
      // Only the start runs one at a time: once the tab exists, it counts as occupying
      // its folder. Waiting for it to come up may take minutes and must not hold the next.
      const started = this.opening.then(() => this.open(call))
      this.opening = started.catch(() => undefined)
      const opened = await started
      return 'ok' in opened ? opened : this.awaitOpened(call, opened)
    }
    if (call.tool === 'close_tab') return this.close(call)
    if (call.tool === 'review_text') return this.review(call, onGone)
    if (call.tool === 'set_tab_status') return this.setStatus(call.args)
    if (call.tool === 'focus_tab') return this.focus(call.args)
    if (call.tool === 'list_sessions') return this.list()
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

  /** Starts the tab `open_tab` asks for: the error to return, or the tab to wait for. */
  private async open(call: Call): Promise<Reply | Opened> {
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
    return { tabId: answer.tabId, claudeSessionId: answer.claudeSessionId, cwd, worktree, title }
  }

  /** Waits for a tab `open` started to come up, and tells the caller what it got. */
  private async awaitOpened(call: Call, opened: Opened): Promise<Reply> {
    const { tabId, claudeSessionId, cwd, worktree, title } = opened
    const started = await this.waitForStart(tabId, claudeSessionId, title, worktree)
    if ('ended' in started) {
      // A tab whose session never got going would start again on the next click without
      // its task or its worktree — those belong to the first start. It goes.
      await this.ask<TabCloseRequest>('close', {
        requestId: randomUUID(),
        parentTabId: call.tabId,
        tabId
      })
      return {
        ok: false,
        error: `The session ended before it got going (exit code ${started.ended.exitCode}), so the tab was closed again. It said:\n${lastLines(started.ended.head)}`
      }
    }
    const child = started.session
    const result = {
      tabId,
      sessionName: child?.name ?? null,
      cwd: child?.cwd || cwd,
      isolation: worktree ? 'worktree' : 'inplace',
      note: child?.name
        ? `The session works with the user and will message you with SendMessage when its task is done. Message it as "${child.name}" - by that name, never by the uds: address its messages come from: that address belongs to one process and is gone once the session is resumed, as every tab is when aterm restarts.`
        : worktree
          ? `The tab is open, but its session has not started after ${WORKTREE_TIMEOUT_MS / 60_000} minutes of creating the worktree. Tell the user to look at the tab. Find the session with ListAgents once it has started.`
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
    name: string,
    worktree: boolean
  ): Promise<{ session?: LiveSession } | { ended: EndedProcess }> {
    const deadline = Date.now() + (worktree ? WORKTREE_TIMEOUT_MS : REGISTRY_TIMEOUT_MS)
    for (;;) {
      const session = sessionId ? findLiveSession(sessionId) : undefined
      if (session?.name === name) return { session }
      const ended = this.tabs.ended(tabId)
      if (ended) return { ended }
      if (Date.now() >= deadline) return { session }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /**
   * Pins a note to the tab in that conversation, or takes it off again with an empty
   * text. Nothing goes to the session: the note is drawn on the tab and that is all.
   */
  private async setStatus(args: Record<string, unknown>): Promise<Reply> {
    const sessionId = sessionIdOf(args)
    if (!sessionId) return { ok: false, error: 'sessionId must be a Claude session id.' }
    const text = typeof args.text === 'string' ? oneLine(args.text) : ''
    const severity = (args.severity ?? 'info') as TabNoteSeverity
    if (!TAB_NOTE_SEVERITIES.includes(severity)) {
      return { ok: false, error: `severity must be one of ${TAB_NOTE_SEVERITIES.join(', ')}.` }
    }
    let href: string | undefined
    if (typeof args.href === 'string' && args.href.trim()) {
      href = webUrl(args.href.trim())
      if (!href) return { ok: false, error: 'href must be an http or https URL.' }
    }
    const note: TabNote | undefined = text ? { text, severity, href } : undefined
    const answer = await this.askControl({ requestId: randomUUID(), kind: 'status', sessionId, note })
    return answer.ok ? { ok: true, tabId: answer.tabId ?? null } : answer
  }

  /**
   * Brings the tab in that conversation to the front. Without such a tab, and asked to
   * `resume`, a new tab resumes the conversation — unless a `claude` outside aterm is in
   * it: two processes on one session is what destroys a conversation.
   */
  private async focus(args: Record<string, unknown>): Promise<Reply> {
    const sessionId = sessionIdOf(args)
    if (!sessionId) return { ok: false, error: 'sessionId must be a Claude session id.' }
    const resume = args.resume === true
    // A running session is either in one of these tabs already, which needs no start, or
    // somewhere else — another aterm, another terminal — where a start would put a second
    // `claude` on it. So a tab that does not run is started only for a session nobody runs.
    const live = findLiveSession(sessionId)
    const found = await this.askControl({
      requestId: randomUUID(),
      kind: 'focus',
      sessionId,
      start: resume && !live
    })
    if (found.ok) {
      this.emit('reveal')
      return { ok: true, tabId: found.tabId ?? null, resumed: false }
    }
    if (found.code !== 'unknown-session' || !resume) return found

    if (live) {
      return {
        ok: false,
        code: 'runs-elsewhere',
        error: `The session runs outside aterm (pid ${live.pid}), so it cannot be resumed in a tab.`
      }
    }
    const cwd = conversationCwd(sessionId)
    if (!cwd) return { ok: false, code: 'unknown-session', error: 'No conversation with that id was found.' }
    const opened = await this.askControl({ requestId: randomUUID(), kind: 'resume', sessionId, cwd })
    if (!opened.ok) return opened
    this.emit('reveal')
    return { ok: true, tabId: opened.tabId ?? null, resumed: true }
  }

  /**
   * Every session aterm knows of: those its tabs are in, running or not, and those
   * running anywhere else on this machine, which have no tab. `state` is what Claude Code
   * says the session is doing, and null for one that does not run.
   */
  private async list(): Promise<Reply> {
    const answer = await this.askControl({ requestId: randomUUID(), kind: 'list' })
    if (!answer.ok) return answer
    const live = new Map(listLiveSessions().map((s) => [s.sessionId, s]))
    const sessions: Record<string, unknown>[] = []
    for (const tab of answer.tabs ?? []) {
      const session = live.get(tab.sessionId)
      live.delete(tab.sessionId)
      sessions.push({
        sessionId: tab.sessionId,
        tabId: tab.tabId,
        title: tab.title,
        name: session?.name ?? null,
        cwd: session?.cwd || tab.cwd,
        state: session?.status ?? null,
        running: session !== undefined,
        tabOpen: true
      })
    }
    for (const session of live.values()) {
      sessions.push({
        sessionId: session.sessionId,
        tabId: null,
        title: null,
        name: session.name ?? null,
        cwd: session.cwd,
        state: session.status ?? null,
        running: true,
        tabOpen: false
      })
    }
    return { ok: true, sessions }
  }

  private askControl(request: ControlRequest): Promise<ControlAnswer> {
    return new Promise((done) => {
      const timer = setTimeout(
        () => this.answerControl(request.requestId, { ok: false, error: 'aterm did not answer in time.' }),
        ANSWER_TIMEOUT_MS
      )
      this.controls.set(request.requestId, (answer) => {
        clearTimeout(timer)
        done(answer)
      })
      this.emit('control', request)
    })
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
    if (typeof data.tool !== 'string') return undefined
    // An outside caller is no tab: it may leave `tabId` out, or send it empty.
    const control = CONTROL_TOOLS.has(data.tool)
    if (!control && typeof data.tabId !== 'string') return undefined
    const args = data.args && typeof data.args === 'object' ? data.args : {}
    const ppid = typeof data.ppid === 'number' ? data.ppid : undefined
    return { tabId: control ? '' : (data.tabId as string), ppid, tool: data.tool, args }
  } catch {
    return undefined
  }
}

function sessionIdOf(args: Record<string, unknown>): string | undefined {
  return typeof args.sessionId === 'string' && UUID.test(args.sessionId) ? args.sessionId : undefined
}

/** A note's text as one line, cut to `MAX_NOTE_LENGTH`. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line
}

/**
 * The URL a note may open, or undefined. Only the web: a click on the note hands it to
 * the shell, and a `file:` URL from an outside caller would be a way to run a program.
 */
function webUrl(href: string): string | undefined {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
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
