import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Task,
  TaskAction,
  TaskActionResult,
  TaskAsk,
  TaskEvent,
  TaskSession,
  TaskSessionInfo
} from '@shared/types'
import { taskBriefing, taskRef } from '@shared/taskBriefing'
import { readJsonFile } from '../util/json'

const SCHEMA_VERSION = 1

/** How many events a task keeps. The activity is a log to glance at, not a history. */
const MAX_EVENTS = 40

/** Done tasks are dropped this long after they were done, at the next start. */
const DONE_KEPT_MS = 30 * 24 * 60 * 60 * 1000

interface StoredTasks {
  version: number
  tasks: Task[]
  /** The last number handed out, kept so that no number is ever given twice. */
  lastNumber?: number
}

/** A call to one of the `task_*` tools, as `TabSpawnServer` hands it over. */
export interface TaskCall {
  /** The tab the calling session runs in. */
  tabId: string
  /** The calling session's name, from Claude Code's registry, for "set by". */
  by?: string
  tool: string
  args: Record<string, unknown>
}

export type TaskReply = { ok: true; text: string } | { ok: false; error: string }

const STATUSES = ['working', 'needs_user', 'blocked', 'done'] as const
type DeclaredStatus = (typeof STATUSES)[number]

/**
 * aterm's task list: the tasks, which sessions work on them, and what those sessions
 * declared about them. Lives in the main process, because the `task_*` tools of the aterm
 * MCP server arrive here and must work while the renderer is busy or reloading; the
 * renderer is sent the whole list on every change (`changed`) — it is small.
 *
 * Kept in `userData/tasks.json`, not in `state.json`: a task outlives every tab that ever
 * worked on it, and `state.json` is rewritten wholesale by the renderer on every change.
 */
export class TaskStore extends EventEmitter {
  private readonly file: string
  private tasks: Task[] = []
  private lastNumber = 0
  private pending?: NodeJS.Timeout

  constructor(
    userData: string,
    /** What the tab of a calling session is, to attach it: main's copy of state.json. */
    private readonly tabInfo: (tabId: string) => TaskSessionInfo | undefined
  ) {
    super()
    this.file = join(userData, 'tasks.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const stored = readJsonFile<StoredTasks>(this.file)
    if (!stored || typeof stored.version !== 'number' || !Array.isArray(stored.tasks)) return
    const cutoff = Date.now() - DONE_KEPT_MS
    this.tasks = stored.tasks
      .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string')
      .filter((t) => !t.doneAt || t.doneAt > cutoff)
      .map((t) => ({
        ...t,
        asks: Array.isArray(t.asks) ? t.asks : [],
        sessions: Array.isArray(t.sessions) ? t.sessions : [],
        activity: Array.isArray(t.activity) ? t.activity : []
      }))
    // Numbers came later than the tasks: those without one get theirs in order of creation.
    this.lastNumber = Math.max(
      typeof stored.lastNumber === 'number' ? stored.lastNumber : 0,
      ...this.tasks.map((t) => (typeof t.number === 'number' ? t.number : 0))
    )
    for (const task of [...this.tasks].sort((a, b) => a.createdAt - b.createdAt)) {
      if (typeof task.number !== 'number') task.number = ++this.lastNumber
    }
  }

  list(): Task[] {
    return this.tasks
  }

  /** The task a tab's session works on, if any. A session is on one task at a time. */
  taskOfTab(tabId: string): Task | undefined {
    return this.tasks.find((t) => t.sessions.some((s) => s.tabId === tabId && !s.closed))
  }

  /** Synchronous and immediate — for before-quit. */
  flush(): void {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = undefined
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const data: StoredTasks = { version: SCHEMA_VERSION, tasks: this.tasks, lastNumber: this.lastNumber }
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // No reason to hold anything up; the next change writes again.
    }
  }

  /* ------------------------------------------------------- From the renderer */

  apply(action: TaskAction): TaskActionResult {
    if (action.kind === 'create') {
      const title = action.title.trim()
      if (!title) return { ok: false, error: 'A task needs a title.' }
      const task = this.create(title, action.source, action.notes, action.cwd, 'you')
      return { ok: true, taskId: task.id }
    }
    if (action.kind === 'tabClosed') {
      this.tabClosed(action.session)
      return { ok: true }
    }
    if (action.kind === 'answered') {
      this.answered(action.tabId)
      return { ok: true }
    }

    const task = this.find(action.taskId)
    if (!task) return { ok: false, error: 'There is no such task.' }

    switch (action.kind) {
      case 'edit': {
        if (action.title !== undefined && action.title.trim()) task.title = action.title.trim()
        if (action.source !== undefined) task.source = action.source.trim() || undefined
        if (action.notes !== undefined) task.notes = action.notes.trim() ? action.notes : undefined
        if (action.cwd !== undefined) task.cwd = action.cwd || undefined
        break
      }
      case 'setDone':
        if (action.done) this.markDone(task, undefined, 'you')
        else {
          task.doneAt = undefined
          this.log(task, 'reopened', 'Reopened', 'you')
        }
        break
      case 'setBlocked':
        task.blocked = action.reason?.trim() || undefined
        // The user saying "it is blocked" is their answer to what the sessions asked: the
        // task waits for something else now, and a question left open would keep it under
        // "Needs you". A review stays - it is a piece of work, not a question.
        if (task.blocked) task.asks = task.asks.filter((a) => a.kind !== 'question')
        this.log(
          task,
          task.blocked ? 'blocked' : 'working',
          task.blocked ? task.blocked : 'No longer blocked',
          'you'
        )
        break
      case 'resolveAsk': {
        const ask = task.asks.find((a) => a.id === action.askId)
        if (!ask) return { ok: true }
        task.asks = task.asks.filter((a) => a !== ask)
        this.log(task, 'resolved', `Done: ${ask.text}`, 'you')
        break
      }
      case 'join':
        this.join(task, action.session)
        break
      case 'leave':
        this.leave(task, action.tabId)
        break
      case 'delete':
        this.tasks = this.tasks.filter((t) => t !== task)
        this.changed()
        return { ok: true }
    }
    this.touch(task)
    return { ok: true, taskId: task.id }
  }

  /* ----------------------------------------------------------- From sessions */

  /** A `task_*` tool call, or undefined when the tool is not one of these. */
  call(call: TaskCall): TaskReply | undefined {
    switch (call.tool) {
      case 'task_list':
        return this.toolList(call)
      case 'task_get':
        return this.toolGet(call)
      case 'task_create':
        return this.toolCreate(call)
      case 'task_join':
        return this.toolJoin(call)
      case 'task_leave':
        return this.toolLeave(call)
      case 'task_update':
        return this.toolUpdate(call)
      default:
        return undefined
    }
  }

  /**
   * The task a tab opened through `open_tab` works on: the caller's, unless the call named
   * another or said "none". An error message when it named one that does not exist.
   */
  taskForChild(parentTabId: string, requested: unknown): Task | undefined | string {
    if (requested === 'none') return undefined
    if (typeof requested === 'string' && requested.trim()) {
      return this.find(requested.trim()) ?? `There is no task "${requested}". task_list names them.`
    }
    return this.taskOfTab(parentTabId)
  }

  /** Puts a tab `open_tab` made on a task. */
  joinTab(taskId: string, session: TaskSessionInfo, by?: string): void {
    const task = this.find(taskId)
    if (!task) return
    this.join(task, session, by)
    this.touch(task)
  }

  private toolList(call: TaskCall): TaskReply {
    const all = call.args.include_done === true
    const mine = this.taskOfTab(call.tabId)
    const tasks = this.tasks
      .filter((t) => all || !t.doneAt)
      .map((t) => ({
        id: taskRef(t),
        title: t.title,
        source: t.source ?? null,
        done: Boolean(t.doneAt),
        blocked: t.blocked ?? null,
        openAsks: t.asks.map((a) => `${a.kind}: ${a.text}`),
        sessions: t.sessions.filter((s) => !s.closed).map((s) => s.name ?? s.tabId),
        yours: t === mine
      }))
    return { ok: true, text: JSON.stringify(tasks, null, 2) }
  }

  private toolGet(call: TaskCall): TaskReply {
    const task = this.target(call)
    if (typeof task === 'string') return { ok: false, error: task }
    return {
      ok: true,
      text: JSON.stringify(
        {
          id: taskRef(task),
          title: task.title,
          source: task.source ?? null,
          notes: task.notes ?? null,
          cwd: task.cwd ?? null,
          done: Boolean(task.doneAt),
          blocked: task.blocked ?? null,
          openAsks: task.asks.map((a) => ({ kind: a.kind, text: a.text, url: a.url ?? null, by: a.by ?? null })),
          sessions: task.sessions.map((s) => ({ name: s.name ?? null, closed: Boolean(s.closed) })),
          lastNote: task.note?.text ?? null,
          recentActivity: task.activity.slice(-10).map((e) => `${e.kind}: ${e.text}${e.by ? ` (${e.by})` : ''}`)
        },
        null,
        2
      )
    }
  }

  private toolCreate(call: TaskCall): TaskReply {
    const { args } = call
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return { ok: false, error: 'title must name the task.' }
    const info = this.tabInfo(call.tabId)
    const task = this.create(
      title,
      str(args.source),
      str(args.notes),
      str(args.cwd) ?? info?.cwd,
      call.by
    )
    if (args.join === true && info) {
      this.join(task, { ...info, name: call.by ?? info.name }, call.by)
      this.touch(task)
    }
    // Joining is where a session learns when to report; the briefing goes with the answer.
    return {
      ok: true,
      text:
        args.join === true && info
          ? `Created task ${taskRef(task)}: "${task.title}", and this session is on it now.\n\n${taskBriefing(task)}`
          : `Created task ${taskRef(task)}: "${task.title}", in the backlog.`
    }
  }

  private toolJoin(call: TaskCall): TaskReply {
    const id = str(call.args.task)
    const task = id ? this.find(id) : undefined
    if (!task) return { ok: false, error: `There is no task "${id ?? ''}". task_list names them.` }
    const info = this.tabInfo(call.tabId)
    if (!info) return { ok: false, error: 'This session is not running in an aterm tab aterm knows.' }
    this.join(task, { ...info, name: call.by ?? info.name }, call.by)
    this.touch(task)
    return {
      ok: true,
      text: `This session is on task ${taskRef(task)} now: "${task.title}".\n\n${taskBriefing(task)}`
    }
  }

  private toolLeave(call: TaskCall): TaskReply {
    const task = this.taskOfTab(call.tabId)
    if (!task) return { ok: true, text: 'This session was not on a task.' }
    this.leave(task, call.tabId, call.by)
    this.touch(task)
    return { ok: true, text: `This session left task ${taskRef(task)}.` }
  }

  private toolUpdate(call: TaskCall): TaskReply {
    const { args } = call
    const task = this.target(call)
    if (typeof task === 'string') return { ok: false, error: task }

    const status = args.status as DeclaredStatus
    if (!STATUSES.includes(status)) {
      return { ok: false, error: `status must be one of ${STATUSES.join(', ')}.` }
    }
    // A session reporting on a task while on none is working on it: it joins, or the list
    // would show the state and nobody behind it.
    if (!this.taskOfTab(call.tabId) && status !== 'done') {
      const info = this.tabInfo(call.tabId)
      if (info) this.join(task, { ...info, name: call.by ?? info.name }, call.by)
    }
    const note = str(args.note)
    const url = str(args.url)
    const title = str(args.title)
    if (title) task.title = title
    if (args.resolve_reviews === true) {
      const reviews = task.asks.filter((a) => a.kind === 'review')
      task.asks = task.asks.filter((a) => a.kind !== 'review')
      for (const r of reviews) this.log(task, 'resolved', `Done: ${r.text}`, call.by)
    }

    switch (status) {
      case 'working':
        task.blocked = undefined
        task.doneAt = undefined
        task.asks = task.asks.filter((a) => !(a.kind === 'question' && a.tabId === call.tabId))
        this.log(task, 'working', note ?? 'Working', call.by)
        break
      case 'needs_user': {
        const kind = args.ask === 'review' ? 'review' : args.ask === 'question' ? 'question' : undefined
        if (!kind) return { ok: false, error: 'needs_user takes ask: "question" or "review".' }
        if (!note) return { ok: false, error: 'note must say what the user is to do.' }
        task.doneAt = undefined
        // One open question per session; a review is one per link.
        task.asks = task.asks.filter((a) =>
          kind === 'question'
            ? !(a.kind === 'question' && a.tabId === call.tabId)
            : !(a.kind === 'review' && (url ? a.url === url : a.text === note))
        )
        const ask: TaskAsk = { id: randomUUID(), kind, text: note, url, tabId: call.tabId, by: call.by, at: Date.now() }
        task.asks.push(ask)
        this.log(task, 'needs_user', kind === 'review' ? `Review: ${note}` : note, call.by)
        break
      }
      case 'blocked':
        if (!note) return { ok: false, error: 'note must say what the task is waiting for.' }
        task.blocked = note
        this.log(task, 'blocked', note, call.by)
        break
      case 'done':
        this.markDone(task, note, call.by)
        break
    }
    if (note) task.note = { text: note, by: call.by, at: Date.now() }
    this.touch(task)

    const shown =
      task.doneAt ? 'Done' : task.asks.length > 0 ? 'Needs you' : task.blocked ? 'Blocked' : 'Working'
    return { ok: true, text: `Task ${taskRef(task)} "${task.title}" is shown as ${shown} now.` }
  }

  /** The task a call is about: the one it names, or the caller's own. */
  private target(call: TaskCall): Task | string {
    const id = str(call.args.task)
    if (id) return this.find(id) ?? `There is no task "${id}". task_list names them.`
    return (
      this.taskOfTab(call.tabId) ??
      'This session is not on a task. Name one with task, join one with task_join, or create one with task_create.'
    )
  }

  /* ------------------------------------------------------------------- Model */

  private create(title: string, source?: string, notes?: string, cwd?: string, by?: string): Task {
    const now = Date.now()
    const task: Task = {
      id: this.newId(),
      number: ++this.lastNumber,
      title,
      source: source?.trim() || undefined,
      notes: notes?.trim() ? notes : undefined,
      cwd: cwd || undefined,
      asks: [],
      sessions: [],
      createdAt: now,
      updatedAt: now,
      activity: []
    }
    this.log(task, 'created', source ? `Created from ${source}` : 'Created', by)
    this.tasks.push(task)
    this.changed()
    return task
  }

  /** Internal only; what the user and Claude see is the number (`taskRef`). */
  private newId(): string {
    for (;;) {
      const id = `t${randomBytes(3).toString('hex')}`
      if (!this.find(id)) return id
    }
  }

  /** By `T7` (any case) as the user and Claude say it, or by the internal id. */
  private find(id: string): Task | undefined {
    const ref = id.trim().toLowerCase()
    return this.tasks.find((t) => t.id === id || taskRef(t).toLowerCase() === ref)
  }

  /** A session is on one task at a time; joining one takes it off the other. */
  private join(task: Task, info: TaskSessionInfo, by?: string): void {
    for (const other of this.tasks) {
      if (other !== task && other.sessions.some((s) => s.tabId === info.tabId && !s.closed)) {
        this.leave(other, info.tabId, by)
        this.touch(other)
      }
    }
    const existing = task.sessions.find((s) => s.tabId === info.tabId)
    const session: TaskSession = {
      tabId: info.tabId,
      claudeSessionId: info.claudeSessionId,
      cwd: info.cwd,
      name: info.name,
      joinedAt: existing?.joinedAt ?? Date.now()
    }
    // A closed session resumed in a new tab is the same session: the new tab replaces it.
    const resumed = (s: TaskSession): boolean =>
      Boolean(s.closed && info.claudeSessionId && s.claudeSessionId === info.claudeSessionId)
    task.sessions = [...task.sessions.filter((s) => s.tabId !== info.tabId && !resumed(s)), session]
    if (!existing || existing.closed) this.log(task, 'joined', `${info.name ?? 'A session'} joined`, by)
    if (!task.cwd) task.cwd = info.cwd
  }

  private leave(task: Task, tabId: string, by?: string): void {
    const session = task.sessions.find((s) => s.tabId === tabId)
    if (!session) return
    task.sessions = task.sessions.filter((s) => s !== session)
    task.asks = task.asks.filter((a) => !(a.kind === 'question' && a.tabId === tabId))
    this.log(task, 'left', `${session.name ?? 'A session'} left`, by)
  }

  /**
   * The tab is gone. Its conversation stays with the task, to be resumed from there, and
   * so does any review it asked for; a question it asked has nobody left to answer it.
   */
  private tabClosed(info: TaskSessionInfo): void {
    for (const task of this.tasks) {
      const session = task.sessions.find((s) => s.tabId === info.tabId && !s.closed)
      if (!session) continue
      session.closed = true
      session.claudeSessionId = info.claudeSessionId ?? session.claudeSessionId
      session.cwd = info.cwd || session.cwd
      session.name = info.name ?? session.name
      task.asks = task.asks.filter((a) => !(a.kind === 'question' && a.tabId === info.tabId))
      this.touch(task)
    }
  }

  /** The tab went back to work after waiting, so the user answered what it asked. */
  private answered(tabId: string): void {
    for (const task of this.tasks) {
      const before = task.asks.length
      task.asks = task.asks.filter((a) => !(a.kind === 'question' && a.tabId === tabId))
      if (task.asks.length !== before) this.touch(task)
    }
  }

  private markDone(task: Task, note: string | undefined, by?: string): void {
    task.doneAt = Date.now()
    task.asks = []
    task.blocked = undefined
    this.log(task, 'done', note ?? 'Done', by)
  }

  private log(task: Task, kind: TaskEvent['kind'], text: string, by?: string): void {
    task.activity.push({ at: Date.now(), kind, text, by })
    if (task.activity.length > MAX_EVENTS) task.activity = task.activity.slice(-MAX_EVENTS)
  }

  private touch(task: Task): void {
    task.updatedAt = Date.now()
    this.changed()
  }

  private changed(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => this.flush(), 300)
    this.emit('changed', this.tasks)
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
