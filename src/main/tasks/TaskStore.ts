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
  TaskSessionInfo,
  TaskStep,
  TaskStepOwner
} from '@shared/types'
import { taskBriefing, taskRef } from '@shared/taskBriefing'
import { currentSteps, ownerText, stepProgress, stepsLine } from '@shared/taskSteps'
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
        steps: Array.isArray(t.steps) ? t.steps.filter(validStep) : [],
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
    for (const task of this.tasks) {
      reviewsToSteps(task)
      dropQuestionsBeforeBlocked(task)
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
      case 'setStepDone': {
        const step = task.steps.find((s) => s.id === action.stepId)
        if (!step || Boolean(step.done) === action.done) return { ok: true }
        step.done = action.done ? { at: Date.now(), by: 'you' } : undefined
        this.log(task, 'step', `${action.done ? '✓' : 'Reopened'} ${step.id} ${step.title}`, 'you')
        this.syncDone(task, !action.done, 'you')
        break
      }
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
      .map((t) => {
        const next = currentSteps(t)[0]
        const { done, total } = stepProgress(t)
        return compact({
          id: taskRef(t),
          title: t.title,
          source: t.source,
          done: t.doneAt ? true : undefined,
          blocked: t.blocked,
          questions: t.asks.length ? t.asks.map((a) => a.text) : undefined,
          next: next ? `${next.id} ${next.title} (${ownerText(next.owner, call.by)})` : undefined,
          steps: total ? `${done}/${total}` : undefined,
          sessions: t.sessions.filter((s) => !s.closed).map((s) => s.name ?? s.tabId),
          yours: t === mine ? true : undefined
        })
      })
    return { ok: true, text: JSON.stringify(tasks) }
  }

  private toolGet(call: TaskCall): TaskReply {
    const task = this.target(call)
    if (typeof task === 'string') return { ok: false, error: task }
    return {
      ok: true,
      text: JSON.stringify(
        compact({
          id: taskRef(task),
          title: task.title,
          source: task.source,
          notes: task.notes,
          cwd: task.cwd,
          done: task.doneAt ? true : undefined,
          blocked: task.blocked,
          steps: stepsLine(task, call.by),
          questions: task.asks.length ? task.asks.map((a) => compact({ text: a.text, by: a.by })) : undefined,
          sessions: task.sessions.map((s) => (s.closed ? `${s.name ?? 'a session'} (closed)` : (s.name ?? 'a session'))),
          lastNote: task.note?.text,
          recentActivity: task.activity.slice(-5).map((e) => `${e.kind}: ${e.text}${e.by ? ` (${e.by})` : ''}`)
        })
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
          ? `Created task ${taskRef(task)}: "${task.title}", and this session is on it now.\n\n${taskBriefing(task, call.by)}`
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
      text: `This session is on task ${taskRef(task)} now: "${task.title}".\n\n${taskBriefing(task, call.by)}`
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

    const status = args.status as DeclaredStatus | undefined
    if (status !== undefined && !STATUSES.includes(status)) {
      return { ok: false, error: `status must be one of ${STATUSES.join(', ')}.` }
    }
    const note = str(args.note)
    const url = str(args.url)
    const title = str(args.title)
    const stepItems = args.steps
    if (stepItems !== undefined && !Array.isArray(stepItems)) {
      return { ok: false, error: 'steps must be a list of steps.' }
    }
    if (!status && !stepItems && !title && args.resolve_reviews !== true) {
      return { ok: false, error: 'Nothing to update: pass steps, a status, or both.' }
    }
    if (status === 'needs_user') {
      if (args.ask !== 'review' && args.ask !== 'question') {
        return { ok: false, error: 'needs_user takes ask: "question" or "review".' }
      }
      if (!note) return { ok: false, error: 'note must say what the user is to do.' }
    }
    if (status === 'blocked' && !note) return { ok: false, error: 'note must say what the task is waiting for.' }

    // Steps first, all or nothing: a call naming a step that does not exist changes
    // nothing at all, so the session can send it again corrected.
    let stepsChange: StepsChange | undefined
    if (stepItems) {
      const result = applySteps(task, stepItems, args.replace === true, call.by, this.ownerOf(task, call))
      if (typeof result === 'string') return { ok: false, error: result }
      stepsChange = result
    }

    // A session reporting on a task while on none is working on it: it joins, or the list
    // would show the state and nobody behind it.
    if (!this.taskOfTab(call.tabId) && status !== 'done') {
      const info = this.tabInfo(call.tabId)
      if (info) this.join(task, { ...info, name: call.by ?? info.name }, call.by)
    }
    if (title) task.title = title
    if (stepsChange) {
      task.steps = stepsChange.steps
      task.lastStepId = stepsChange.lastStepId
      if (stepsChange.log.length) this.log(task, 'step', stepsChange.log.join(' · '), call.by)
    }
    if (args.resolve_reviews === true) this.resolveReviews(task, url, call.by)

    switch (status) {
      case 'working':
        task.blocked = undefined
        task.doneAt = undefined
        task.asks = task.asks.filter((a) => a.tabId !== call.tabId)
        this.log(task, 'working', note ?? 'Working', call.by)
        break
      case 'needs_user':
        task.doneAt = undefined
        if (args.ask === 'review') this.reviewStep(task, note!, url, call.by)
        else {
          // One open question per session.
          task.asks = task.asks.filter((a) => a.tabId !== call.tabId)
          const ask: TaskAsk = {
            id: randomUUID(),
            kind: 'question',
            text: note!,
            url,
            tabId: call.tabId,
            by: call.by,
            at: Date.now()
          }
          task.asks.push(ask)
          this.log(task, 'needs_user', note!, call.by)
        }
        break
      case 'blocked':
        task.blocked = note
        this.log(task, 'blocked', note!, call.by)
        break
      case 'done':
        this.markDone(task, note, call.by)
        break
    }
    if (status !== 'done' && (stepsChange || args.resolve_reviews === true)) {
      this.syncDone(task, stepsChange?.reopened ?? false, call.by)
    }
    if (note) task.note = { text: note, by: call.by, at: Date.now() }
    this.touch(task)

    return {
      ok: true,
      text: `Task ${taskRef(task)} "${task.title}" is shown as ${shownAs(task)} now.\nSteps: ${stepsLine(task, call.by)}`
    }
  }

  /**
   * How an owner a session wrote is read: "me" is the calling session, by the name Claude
   * Code knows it by; "user" the user; "session:<name>", or the name of a session on the
   * task, a session; anything else someone outside aterm.
   */
  private ownerOf(task: Task, call: TaskCall): (text: string) => TaskStepOwner | string {
    return (text) => {
      const value = text.trim()
      const lower = value.toLowerCase()
      if (lower === 'me') {
        const name = call.by ?? this.tabInfo(call.tabId)?.name
        return name ? { kind: 'session', name } : "aterm does not know this session's name; give the owner by name."
      }
      if (lower === 'user' || lower === 'you') return { kind: 'user' }
      if (lower.startsWith('session:')) {
        const name = value.slice('session:'.length).trim()
        return name ? { kind: 'session', name } : 'session: needs a name after it.'
      }
      const session = task.sessions.find((s) => s.name?.toLowerCase() === lower)
      if (session?.name) return { kind: 'session', name: session.name }
      return value ? { kind: 'other', who: value } : 'owner must not be empty.'
    }
  }

  /**
   * A review asked for the old way (`needs_user`, ask "review") is a step owned by the
   * user and due now: it does not wait for the rest of the chain. One per link.
   */
  private reviewStep(task: Task, text: string, url: string | undefined, by?: string): void {
    const existing = task.steps.find(
      (s) => !s.done && s.owner.kind === 'user' && (url ? s.url === url : s.title === text)
    )
    if (existing) {
      existing.title = text
      existing.url = url ?? existing.url
      existing.at = Date.now()
      existing.by = by
    } else {
      task.lastStepId = nextStepId(task)
      task.steps.push({ id: task.lastStepId, title: text, owner: { kind: 'user' }, url, after: [], at: Date.now(), by })
    }
    this.log(task, 'needs_user', `Review: ${text}`, by)
  }

  /** `resolve_reviews`: the user's open steps with a link - or the one with this link - are done. */
  private resolveReviews(task: Task, url: string | undefined, by?: string): void {
    for (const step of task.steps) {
      if (step.done || step.owner.kind !== 'user' || !step.url) continue
      if (url && step.url !== url) continue
      step.done = { at: Date.now(), by }
      this.log(task, 'resolved', `Done: ${step.title}`, by)
    }
  }

  /**
   * A chain whose every step is done is a task that is done. One that gets an open step
   * again - added, or one taken back - is open again; one the user marked done with steps
   * still open stays done, because that was their decision.
   */
  private syncDone(task: Task, reopened: boolean, by?: string): void {
    const open = task.steps.some((s) => !s.done)
    if (task.steps.length > 0 && !open && !task.doneAt) this.markDone(task, undefined, by)
    else if (open && reopened && task.doneAt) {
      task.doneAt = undefined
      this.log(task, 'reopened', 'Reopened', by)
    }
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
      steps: [],
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

/**
 * A blocked task's questions that are older than the block count as answered - the rule
 * `setBlocked` applies when the user blocks a task, applied again to what is stored. Tasks
 * blocked before that rule existed kept their question and stayed under "Needs you",
 * because an open question outranks blocked. A question asked after the block stays.
 */
function dropQuestionsBeforeBlocked(task: Task): void {
  if (!task.blocked) return
  const blockedAt = [...task.activity].reverse().find((e) => e.kind === 'blocked')?.at
  if (blockedAt === undefined) return
  task.asks = task.asks.filter((a) => a.kind !== 'question' || a.at > blockedAt)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** What a `task_update` with steps leaves behind, before it is committed. */
interface StepsChange {
  steps: TaskStep[]
  lastStepId: number
  /** One short entry per change, for the activity. */
  log: string[]
  /** A step was added or taken back, so a done task is open again. */
  reopened: boolean
}

/**
 * Applies the `steps` of a `task_update` to a copy of the task's chain: upsert by id, so
 * several sessions can edit one chain without overwriting each other, or with `replace`
 * the whole chain in the order given. An error message, and nothing changed, when an item
 * does not add up.
 */
function applySteps(
  task: Task,
  items: unknown[],
  replace: boolean,
  by: string | undefined,
  owner: (text: string) => TaskStepOwner | string
): StepsChange | string {
  const now = Date.now()
  const existing = task.steps.map((s) => ({ ...s }))
  let steps = replace ? [] : [...existing]
  let lastStepId = nextStepId(task) - 1
  const log: string[] = []
  let reopened = false
  const mentioned = new Set<number>()

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return 'Each step must be an object.'
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'number' ? item.id : undefined
    if (item.id !== undefined && id === undefined) return 'A step id is a number.'
    if (id !== undefined && mentioned.has(id)) return `Step ${id} is named twice.`

    if (item.remove === true) {
      if (id === undefined) return 'remove needs the id of the step.'
      if (!existing.some((s) => s.id === id)) return `There is no step ${id}.`
      mentioned.add(id)
      steps = steps.filter((s) => s.id !== id)
      log.push(`−${id}`)
      continue
    }

    let step: TaskStep
    if (id !== undefined) {
      const found = existing.find((s) => s.id === id)
      if (!found) return `There is no step ${id}. Leave the id out to add a step.`
      step = found
      if (replace) steps.push(step)
    } else {
      const title = str(item.title)
      if (!title) return 'A new step needs a title (and no id).'
      // A step nobody is named for belongs to the session adding it.
      const who = owner(typeof item.owner === 'string' ? item.owner : 'me')
      if (typeof who === 'string') return who
      step = { id: ++lastStepId, title, owner: who, at: now, by }
      steps.push(step)
      log.push(`+${step.id} ${title}`)
      if (item.done !== true) reopened = true
    }
    mentioned.add(step.id)

    let edited = false
    const title = str(item.title)
    if (id !== undefined && title && title !== step.title) {
      step.title = title
      edited = true
    }
    if (id !== undefined && typeof item.owner === 'string') {
      const who = owner(item.owner)
      if (typeof who === 'string') return who
      if (JSON.stringify(who) !== JSON.stringify(step.owner)) {
        step.owner = who
        edited = true
      }
    }
    let touched = edited
    if (typeof item.done === 'boolean' && item.done !== Boolean(step.done)) {
      step.done = item.done ? { at: now, by } : undefined
      if (id !== undefined) log.push(item.done ? `✓${step.id}` : `reopened ${step.id}`)
      if (!item.done) reopened = true
      touched = true
    }
    if (item.blocked !== undefined) {
      if (typeof item.blocked !== 'string') return 'blocked is the reason, or "" to clear it.'
      const reason = item.blocked.trim() || undefined
      if (reason !== step.blocked) {
        step.blocked = reason
        if (id !== undefined) log.push(reason ? `${step.id} blocked: ${reason}` : `${step.id} unblocked`)
        touched = true
      }
    }
    if (item.after !== undefined) {
      if (item.after === null) step.after = undefined
      else if (!Array.isArray(item.after) || !item.after.every((a) => typeof a === 'number')) {
        return 'after is a list of step ids, or null for "the step before it".'
      } else step.after = item.after as number[]
      edited = true
    }
    for (const key of ['url', 'note'] as const) {
      const value = item[key]
      if (value === undefined) continue
      if (typeof value !== 'string') return `${key} is text, or "" to clear it.`
      step[key] = value.trim() || undefined
      edited = true
    }
    if (edited && id !== undefined) log.push(`edited ${step.id}`)
    if (edited || touched) {
      step.at = now
      step.by = by
    }

    // Where it goes: before the step it names, else where it is (or at the end, if new).
    if (item.before !== undefined) {
      if (typeof item.before !== 'number') return 'before is the id of a step.'
      steps = steps.filter((s) => s !== step)
      const at = steps.findIndex((s) => s.id === item.before)
      if (at < 0) return `There is no step ${item.before} to put it before.`
      steps.splice(at, 0, step)
    }
  }

  if (replace) {
    // Done steps left out are history rather than part of the chain being replaced: they
    // stay, in front. Open ones left out are gone.
    const keptDone = existing.filter((s) => !mentioned.has(s.id) && s.done)
    const dropped = existing.filter((s) => !mentioned.has(s.id) && !s.done)
    steps = [...keptDone, ...steps]
    if (dropped.length) log.push(`−${dropped.map((s) => s.id).join(',')}`)
  }

  const ids = new Set(steps.map((s) => s.id))
  for (const step of steps) {
    for (const dep of step.after ?? []) {
      if (dep === step.id) return `Step ${step.id} cannot come after itself.`
      if (!ids.has(dep)) return `Step ${step.id} comes after step ${dep}, which does not exist.`
    }
  }
  if (hasCycle(steps)) return "The steps' after lists go round in a circle; none of them could ever start."
  return { steps, lastStepId, log: [...new Set(log)], reopened }
}

/** A circle in the dependencies leaves every step in it waiting for the others for good. */
function hasCycle(steps: TaskStep[]): boolean {
  const deps = new Map<number, number[]>()
  steps.forEach((s, i) => deps.set(s.id, s.after ?? (i > 0 ? [steps[i - 1].id] : [])))
  const state = new Map<number, 'visiting' | 'clear'>()
  const visit = (id: number): boolean => {
    if (state.get(id) === 'clear') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    for (const dep of deps.get(id) ?? []) if (deps.has(dep) && visit(dep)) return true
    state.set(id, 'clear')
    return false
  }
  return steps.some((s) => visit(s.id))
}

/** The next step id: one past every id handed out so far. */
function nextStepId(task: Task): number {
  return Math.max(task.lastStepId ?? 0, ...task.steps.map((s) => s.id)) + 1
}

/**
 * A review the user was asked for, stored the old way as an ask, becomes a step owned by
 * the user at the end of the chain, due at once. Questions stay asks.
 */
function reviewsToSteps(task: Task): void {
  const asks = task.asks as Array<Omit<TaskAsk, 'kind'> & { kind: string }>
  const reviews = asks.filter((a) => a.kind === 'review')
  if (reviews.length === 0) return
  for (const r of reviews) {
    task.lastStepId = nextStepId(task)
    task.steps.push({ id: task.lastStepId, title: r.text, owner: { kind: 'user' }, url: r.url, after: [], at: r.at, by: r.by })
  }
  task.asks = asks.filter((a): a is TaskAsk => a.kind === 'question')
}

function validStep(step: unknown): step is TaskStep {
  const s = step as TaskStep | undefined
  return Boolean(s && typeof s.id === 'number' && typeof s.title === 'string' && s.owner && typeof s.owner.kind === 'string')
}

/** What the list shows the task as, so far as main can tell without the tabs. */
function shownAs(task: Task): string {
  if (task.doneAt) return 'Done'
  if (task.asks.length > 0) return 'Needs you'
  if (task.blocked) return 'Blocked'
  const current = currentSteps(task)
  if (current.some((s) => s.owner.kind === 'user' && !s.blocked)) return 'Needs you'
  if (current.length > 0 && current.every((s) => s.blocked || s.owner.kind === 'other')) return 'Blocked'
  return 'Working'
}

/** Leaves out what is not there, so an answer carries no `null`s. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>
}
