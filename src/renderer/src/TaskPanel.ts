import type { Task, TaskAction, TaskAsk, TaskEvent, TaskSession } from '@shared/types'
import { describeSource, isLink } from './taskSource'

/**
 * What the task list shows for a task. Only `blocked`, the asks and done are stored; the
 * rest is read off the tabs, which aterm watches anyway — the most urgent wins:
 * something waits for the user, the task is blocked, a session on it works, or none of it.
 */
export type TaskShownState = 'needs_user' | 'blocked' | 'working' | 'backlog' | 'done'

/** A session on a task, as its tab stands right now. */
export interface TaskSessionView {
  session: TaskSession
  name: string
  /** The tab still exists. */
  open: boolean
  /** An agent tab (✳) rather than a shell (❯), as the tab bar tells them apart. */
  agent: boolean
  running: boolean
  working: boolean
  /** Waiting for the user, seen or not. */
  waiting: boolean
  /** Waiting and not looked at — the tab bar's red dot. */
  alarm: boolean
  folder: string
}

export interface TaskView {
  task: Task
  state: TaskShownState
  sessions: TaskSessionView[]
  /** Some session on it carries the tab bar's red dot. */
  alarm: boolean
}

export interface TaskPanelHandlers {
  newTask(): void
  act(action: TaskAction): void
  goToTab(tabId: string): void
  resume(task: Task, session: TaskSession): void
  startSession(task: Task): void
  /** Puts the tab in front on the task without a word to its session. */
  attachCurrent(task: Task): void
  /** Puts the tab in front on the task and types the task into its prompt. */
  sendToCurrent(task: Task): void
  groupTabs(task: Task): void
  changeFolder(task: Task): void
  stateMenu(task: Task, anchor: HTMLElement): void
  /** Esc in the list: the keyboard goes back to whatever is in front. */
  leave(): void
}

/** What the panel needs to know besides the tasks. */
export interface TaskPanelContext {
  /** The tab in front, to offer attaching it. */
  current?: {
    tabId: string
    name: string
    /** A Claude session runs in it, which can be told about the task. */
    claude: boolean
  }
}

const SECTIONS: Array<{ state: TaskShownState; label: string }> = [
  { state: 'needs_user', label: 'Needs you' },
  { state: 'blocked', label: 'Blocked' },
  { state: 'working', label: 'Working' },
  { state: 'backlog', label: 'Backlog' }
]

/**
 * The task list beside the terminals: the tasks by state, and one task opened in their
 * place. It is rebuilt only when what it shows has changed — `render` in main.ts runs about
 * once a second per working tab, and a rebuild every time would restart every breath and
 * take the caret out of the notes. The fields one types into are made once per opened task
 * and only written to while they do not have the focus.
 */
export class TaskPanel {
  readonly el: HTMLElement
  private readonly filter: HTMLInputElement
  private readonly list: HTMLDivElement
  private readonly listView: HTMLDivElement
  private readonly detailView: HTMLDivElement
  private views: TaskView[] = []
  private ctx: TaskPanelContext = {}
  private openId?: string
  private showDone = false
  private signature = ''
  /** The opened task's fields, kept across rebuilds. */
  private detail?: {
    taskId: string
    title: HTMLInputElement
    notes: HTMLTextAreaElement
    dynamic: HTMLDivElement
    notesTimer?: ReturnType<typeof setTimeout>
  }

  constructor(private readonly handlers: TaskPanelHandlers) {
    this.el = document.createElement('aside')
    this.el.className = 'task-panel'
    this.el.setAttribute('aria-label', 'Tasks')

    this.listView = div('task-list-view')
    const head = div('task-head')
    const h = document.createElement('h2')
    h.textContent = 'Tasks'
    const add = button('New task', 'task-new primary')
    add.title = 'New task (Ctrl+Shift+K)'
    add.addEventListener('click', () => this.handlers.newTask())
    head.append(h, add)

    this.filter = document.createElement('input')
    this.filter.className = 'task-filter'
    this.filter.placeholder = 'Filter…'
    this.filter.spellcheck = false
    this.filter.setAttribute('aria-label', 'Filter tasks')
    this.filter.addEventListener('input', () => this.rebuild())

    this.list = div('task-list')
    this.listView.append(head, this.filter, this.list)

    this.detailView = div('task-detail-view')
    this.detailView.hidden = true

    this.el.append(this.listView, this.detailView)
    this.el.addEventListener('keydown', (ev) => this.onKey(ev))

    let open = false
    try {
      open = localStorage.getItem('tasksOpen') === '1'
    } catch {
      // Nothing to remember it by; it starts closed.
    }
    this.el.hidden = !open
    // Relative times ("12 min") age without anything changing.
    setInterval(() => {
      if (!this.el.hidden) this.rebuild()
    }, 60_000)
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  /** Whether the keyboard is in the panel. */
  hasFocus(): boolean {
    return this.el.contains(document.activeElement)
  }

  setOpen(open: boolean): void {
    if (this.isOpen() === open) return
    this.el.hidden = !open
    try {
      localStorage.setItem('tasksOpen', open ? '1' : '0')
    } catch {
      // Remembered for this run only.
    }
    if (open) this.rebuild()
  }

  focus(): void {
    if (this.openId && this.detail) this.detailView.querySelector<HTMLElement>('.task-back')?.focus()
    else this.filter.focus()
  }

  /** Opens one task in the list's place. */
  show(taskId: string): void {
    this.setOpen(true)
    this.openId = taskId
    this.rebuild()
    this.focus()
  }

  update(views: TaskView[], ctx: TaskPanelContext): void {
    this.views = views
    this.ctx = ctx
    if (this.isOpen()) this.rebuild(false)
  }

  /* ------------------------------------------------------------------ Build */

  private rebuild(force = true): void {
    const signature = JSON.stringify([
      this.views.map((v) => [v.task, v.state, v.sessions.map((s) => [s.name, s.open, s.agent, s.running, s.working, s.waiting, s.alarm])]),
      this.ctx.current,
      this.openId,
      this.showDone
    ])
    if (!force && signature === this.signature) return
    this.signature = signature

    const opened = this.openId ? this.views.find((v) => v.task.id === this.openId) : undefined
    if (this.openId && !opened) this.openId = undefined
    this.listView.hidden = Boolean(opened)
    this.detailView.hidden = !opened
    if (opened) this.buildDetail(opened)
    else {
      this.detail = undefined
      this.detailView.replaceChildren()
      this.buildList()
    }
  }

  private buildList(): void {
    const query = this.filter.value.trim().toLowerCase()
    const matching = this.views.filter(
      (v) =>
        !query ||
        v.task.title.toLowerCase().includes(query) ||
        (v.task.source ?? '').toLowerCase().includes(query)
    )
    const nodes: HTMLElement[] = []
    for (const { state, label } of SECTIONS) {
      const tasks = matching.filter((v) => v.state === state).sort(byUrgency)
      if (tasks.length === 0) continue
      nodes.push(sectionHead(state, label, tasks.length))
      for (const view of tasks) nodes.push(this.row(view))
    }
    const done = matching.filter((v) => v.state === 'done').sort((a, b) => (b.task.doneAt ?? 0) - (a.task.doneAt ?? 0))
    if (done.length > 0) {
      const toggle = button('', 'task-done-toggle')
      toggle.setAttribute('aria-expanded', String(this.showDone))
      toggle.append(chevron(this.showDone), text(`Done `), span('task-count', String(done.length)))
      toggle.addEventListener('click', () => {
        this.showDone = !this.showDone
        this.rebuild()
      })
      nodes.push(toggle)
      if (this.showDone) for (const view of done) nodes.push(this.row(view))
    }
    if (nodes.length === 0) {
      const empty = div('task-empty')
      empty.textContent = query
        ? 'No task matches.'
        : 'No tasks yet. Add one with “New task” or Ctrl+Shift+K — or ask a session to create one.'
      nodes.push(empty)
    }
    this.list.replaceChildren(...nodes)
  }

  private row(view: TaskView): HTMLElement {
    const { task, state } = view
    const row = button('', `task-row state-${state}`)
    row.addEventListener('click', () => this.show(task.id))

    const body = div('task-row-body')
    const top = div('task-row-top')
    top.append(span('task-title', task.title))
    if (task.source) top.append(sourceChip(task.source))
    body.append(top)

    const line = reasonLine(view)
    if (line) body.append(line)
    if (task.note && state !== 'done' && task.note.text !== line?.textContent) {
      body.append(span('task-note', `“${task.note.text}”`))
    }

    const live = view.sessions.filter((s) => s.open)
    if (live.length > 0 || state !== 'backlog') {
      const foot = div('task-row-foot')
      for (const s of live) foot.append(sessionMark(s))
      foot.append(span('task-age', ago(state === 'done' ? (task.doneAt ?? task.updatedAt) : task.updatedAt)))
      body.append(foot)
    }

    row.append(stateIcon(view), body)
    return row
  }

  private buildDetail(view: TaskView): void {
    const { task } = view
    if (this.detail?.taskId !== task.id) this.makeDetail(task)
    const detail = this.detail!
    if (document.activeElement !== detail.title) detail.title.value = task.title
    if (document.activeElement !== detail.notes) detail.notes.value = task.notes ?? ''
    detail.dynamic.replaceChildren(...this.detailSections(view))
  }

  private makeDetail(task: Task): void {
    const back = button('', 'task-back')
    back.setAttribute('aria-label', 'Back to all tasks')
    back.append(chevron(false, true), text('Tasks'))
    back.addEventListener('click', () => this.back())

    const title = document.createElement('input')
    title.className = 'task-title-input'
    title.setAttribute('aria-label', 'Title')
    title.spellcheck = false
    title.addEventListener('change', () => this.handlers.act({ kind: 'edit', taskId: task.id, title: title.value }))
    title.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') title.blur()
    })

    const notes = document.createElement('textarea')
    notes.className = 'task-notes'
    notes.rows = 4
    notes.placeholder = 'Notes — every session on this task reads them through task_get.'
    notes.setAttribute('aria-label', 'Notes')
    const saveNotes = (): void => this.handlers.act({ kind: 'edit', taskId: task.id, notes: notes.value })
    notes.addEventListener('input', () => {
      if (this.detail?.notesTimer) clearTimeout(this.detail.notesTimer)
      if (this.detail) this.detail.notesTimer = setTimeout(saveNotes, 600)
    })
    notes.addEventListener('blur', () => {
      if (this.detail?.notesTimer) clearTimeout(this.detail.notesTimer)
      saveNotes()
    })

    const dynamic = div('task-detail-dynamic')
    const notesBlock = div('task-section')
    notesBlock.append(sectionTitle('Notes'), notes)
    const scroll = div('task-detail-scroll')
    scroll.append(dynamic, notesBlock)
    // Notes sit between the live part and the activity, which `detailSections` appends to
    // the end of the scroll area through `activity`.
    const activity = div('task-activity-host')
    scroll.append(activity)

    this.detailView.replaceChildren(back, title, scroll)
    this.detail = { taskId: task.id, title, notes, dynamic }
  }

  private detailSections(view: TaskView): HTMLElement[] {
    const { task } = view
    const nodes: HTMLElement[] = []

    // State, who set it, and where the task came from.
    const meta = div('task-meta')
    const chip = button('', `task-state-chip state-${view.state}`)
    chip.title = 'Change state'
    chip.append(stateIcon(view), text(STATE_LABELS[view.state]), chevron(true))
    chip.addEventListener('click', () => this.handlers.stateMenu(task, chip))
    meta.append(chip)
    const last = lastDeclared(task)
    if (last) meta.append(span('task-meta-by', `${last.by ? `${last.by} · ` : ''}${ago(last.at)}`))
    nodes.push(meta)
    if (task.source) {
      const src = describeSource(task.source)
      const line = div('task-source')
      if (isLink(task.source)) {
        const a = document.createElement('a')
        a.href = task.source
        a.target = '_blank'
        a.rel = 'noreferrer'
        a.textContent = src.description
        line.append(a)
      } else line.textContent = src.description
      nodes.push(line)
    }

    // What waits for the user: what sessions asked, and tabs that wait without having said.
    const asked = new Set(task.asks.map((a) => a.tabId).filter(Boolean))
    const silent = view.sessions.filter((s) => s.open && s.waiting && !asked.has(s.session.tabId))
    if (task.asks.length > 0 || silent.length > 0) {
      const box = div('task-asks')
      box.append(sectionTitle('Waiting for you'))
      for (const ask of task.asks) box.append(this.askCard(task, ask, view))
      for (const s of silent) {
        const card = div('task-ask')
        card.append(askIcon('question'))
        const body = div('task-ask-body')
        body.append(span('task-ask-text', `${s.name} is waiting for you`))
        const actions = div('task-actions')
        actions.append(this.goTo(s.session.tabId))
        body.append(actions)
        card.append(body)
        box.append(card)
      }
      nodes.push(box)
    }

    if (task.blocked && !task.doneAt) {
      const box = div('task-blocked')
      box.append(sectionTitle('Blocked'), span('task-blocked-text', task.blocked))
      const unblock = button('Unblock', '')
      unblock.addEventListener('click', () => this.handlers.act({ kind: 'setBlocked', taskId: task.id }))
      const actions = div('task-actions')
      actions.append(unblock)
      box.append(actions)
      nodes.push(box)
    }

    // The sessions on it, and ways to put more on it.
    const sessions = div('task-section')
    const live = view.sessions.filter((s) => s.open)
    sessions.append(sectionTitle(`Sessions${view.sessions.length ? ` · ${view.sessions.length}` : ''}`))
    if (view.sessions.length > 0) {
      const box = div('task-sessions')
      for (const s of [...live, ...view.sessions.filter((s) => !s.open)]) box.append(this.sessionRow(task, s))
      sessions.append(box)
    }
    const actions = div('task-actions')
    const start = button('Start a session', 'primary')
    start.title = task.cwd ? `A Claude tab in ${task.cwd}, told about this task` : 'A Claude tab, told about this task'
    start.addEventListener('click', () => this.handlers.startSession(task))
    actions.append(start)
    // The tab in front is the one the user means: sending the task there is the other way
    // to start on it, next to a new session. Attaching is the quiet variant - the tab goes
    // on the task, and its session is told nothing.
    const current = this.ctx.current
    if (current && !view.sessions.some((s) => s.open && s.session.tabId === current.tabId)) {
      if (current.claude) {
        const send = button('Send to current tab', '')
        send.title = `Put “${current.name}” on this task and type the task into its prompt`
        send.addEventListener('click', () => this.handlers.sendToCurrent(task))
        actions.append(send)
      }
      const attach = button('Attach', 'quiet')
      attach.title = `Put “${current.name}” on this task without telling its session`
      attach.addEventListener('click', () => this.handlers.attachCurrent(task))
      actions.append(attach)
    }
    if (live.length >= 2) {
      const group = button('Group tabs', 'quiet')
      group.title = 'Put the open tabs of this task into one tab group, named after it'
      group.addEventListener('click', () => this.handlers.groupTabs(task))
      actions.append(group)
    }
    sessions.append(actions)
    nodes.push(sessions)

    const folder = div('task-folder')
    folder.append(span('task-folder-path', task.cwd ?? 'No folder — sessions start in the current tab’s'))
    const change = button('Change…', 'quiet')
    change.addEventListener('click', () => this.handlers.changeFolder(task))
    folder.append(change)
    nodes.push(folder)

    // The activity goes to the end, below the notes, which are not rebuilt.
    const host = this.detailView.querySelector('.task-activity-host')
    if (host) host.replaceChildren(this.activity(task), this.footer(task))
    return nodes
  }

  private askCard(task: Task, ask: TaskAsk, view: TaskView): HTMLElement {
    const card = div(`task-ask kind-${ask.kind}`)
    card.append(askIcon(ask.kind))
    const body = div('task-ask-body')
    body.append(span('task-ask-kind', ask.kind === 'review' ? 'Review & merge' : 'Question'))
    body.append(span('task-ask-text', ask.text))
    body.append(span('task-ask-by', `${ask.by ?? 'A session'} · ${ago(ask.at)}`))
    const actions = div('task-actions')
    if (ask.url) {
      const a = document.createElement('a')
      a.className = 'task-button primary'
      a.href = ask.url
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.textContent = ask.kind === 'review' ? 'Open in browser' : 'Open link'
      actions.append(a)
    }
    const tab = ask.tabId ? view.sessions.find((s) => s.session.tabId === ask.tabId && s.open) : undefined
    if (tab) actions.append(this.goTo(tab.session.tabId))
    const done = button(ask.kind === 'review' ? 'Mark merged' : 'Mark answered', '')
    done.addEventListener('click', () => this.handlers.act({ kind: 'resolveAsk', taskId: task.id, askId: ask.id }))
    actions.append(done)
    body.append(actions)
    card.append(body)
    return card
  }

  private sessionRow(task: Task, s: TaskSessionView): HTMLElement {
    const row = div(`task-session${s.open ? '' : ' closed'}`)
    row.append(sessionMark(s, false))
    const body = div('task-session-body')
    body.append(span('task-session-name', s.name))
    const what = !s.open
      ? 'tab closed · resumable'
      : s.alarm || s.waiting
        ? 'waiting for you'
        : s.working
          ? 'working'
          : s.running
            ? 'idle'
            : 'not started'
    body.append(span('task-session-sub', `${s.folder} · ${what}`))
    row.append(body)
    if (s.open) row.append(this.goTo(s.session.tabId))
    else if (s.session.claudeSessionId) {
      const resume = button('Resume', '')
      resume.addEventListener('click', () => this.handlers.resume(task, s.session))
      row.append(resume)
    }
    const detach = button('', 'task-detach')
    detach.setAttribute('aria-label', `Take ${s.name} off this task`)
    detach.title = 'Take off this task'
    detach.textContent = '×'
    detach.addEventListener('click', () => this.handlers.act({ kind: 'leave', taskId: task.id, tabId: s.session.tabId }))
    row.append(detach)
    return row
  }

  private goTo(tabId: string): HTMLButtonElement {
    const go = button('Go to tab', '')
    go.addEventListener('click', () => this.handlers.goToTab(tabId))
    return go
  }

  private activity(task: Task): HTMLElement {
    const box = div('task-section')
    box.append(sectionTitle('Activity'))
    const list = document.createElement('ol')
    list.className = 'task-activity'
    for (const event of [...task.activity].reverse().slice(0, 15)) {
      const li = document.createElement('li')
      li.className = `event-${event.kind}`
      li.append(span('task-event-dot', ''))
      const body = div('task-event-body')
      body.append(span('task-event-text', eventText(event)))
      body.append(span('task-event-by', `${event.by ? `${event.by} · ` : ''}${ago(event.at)}`))
      li.append(body)
      list.append(li)
    }
    box.append(list)
    return box
  }

  private footer(task: Task): HTMLElement {
    const foot = div('task-actions task-footer')
    const done = button(task.doneAt ? 'Reopen' : 'Mark done', '')
    done.addEventListener('click', () => this.handlers.act({ kind: 'setDone', taskId: task.id, done: !task.doneAt }))
    const del = button('Delete task', 'quiet danger')
    del.addEventListener('click', () => {
      this.handlers.act({ kind: 'delete', taskId: task.id })
      this.back()
    })
    foot.append(done, del)
    return foot
  }

  /* ---------------------------------------------------------------- Keyboard */

  private back(): void {
    this.openId = undefined
    this.rebuild()
    this.filter.focus()
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    if (this.openId) this.back()
    else this.handlers.leave()
  }
}

/* ------------------------------------------------------------------ Pieces */

const STATE_LABELS: Record<TaskShownState, string> = {
  needs_user: 'Needs you',
  blocked: 'Blocked',
  working: 'Working',
  backlog: 'Backlog',
  done: 'Done'
}

/** Within a section: what the user has not seen first, then the most recent. */
function byUrgency(a: TaskView, b: TaskView): number {
  return Number(b.alarm) - Number(a.alarm) || b.task.updatedAt - a.task.updatedAt
}

/** The one line under a task's title that says why it is where it is. */
function reasonLine(view: TaskView): HTMLElement | undefined {
  const { task, state } = view
  if (state === 'needs_user') {
    const ask = task.asks[task.asks.length - 1]
    const waiting = view.sessions.find((s) => s.open && s.waiting)
    const line = div('task-reason needs')
    if (ask) {
      line.append(askIcon(ask.kind), text(ask.kind === 'review' ? `Review: ${ask.text}` : ask.text))
      if (task.asks.length > 1) line.append(span('task-more', `+${task.asks.length - 1}`))
    } else if (waiting) line.append(askIcon('question'), text(`${waiting.name} is waiting for you`))
    return line
  }
  if (state === 'blocked') {
    const line = div('task-reason blocked')
    line.textContent = task.blocked ?? ''
    return line
  }
  return undefined
}

/** The last state a session or the user declared, for "set by … ago". */
function lastDeclared(task: Task): TaskEvent | undefined {
  const kinds = new Set<TaskEvent['kind']>(['working', 'needs_user', 'blocked', 'done', 'reopened', 'created'])
  return [...task.activity].reverse().find((e) => kinds.has(e.kind))
}

function eventText(event: TaskEvent): string {
  switch (event.kind) {
    case 'needs_user':
      return `Needs you — ${event.text}`
    case 'blocked':
      return `Blocked — ${event.text}`
    case 'working':
      return event.text === 'Working' || event.text === 'No longer blocked' ? event.text : `Working — ${event.text}`
    case 'done':
      return event.text === 'Done' ? 'Done' : `Done — ${event.text}`
    default:
      return event.text
  }
}

function sectionHead(state: TaskShownState, label: string, count: number): HTMLElement {
  const head = div(`task-section-head state-${state}`)
  head.append(stateGlyph(state), text(label), span('task-count', String(count)))
  return head
}

function sectionTitle(label: string): HTMLElement {
  const h = document.createElement('h3')
  h.className = 'task-section-title'
  h.textContent = label
  return h
}

function sourceChip(source: string): HTMLElement {
  const chip = span('task-source-chip', describeSource(source).label)
  chip.title = source
  return chip
}

/** A task's mark in the list: its state, breathing while it works. */
function stateIcon(view: TaskView): HTMLElement {
  const el = stateGlyph(view.state)
  if (view.alarm) el.classList.add('alarm')
  return el
}

function stateGlyph(state: TaskShownState): HTMLElement {
  const el = span(`task-glyph state-${state}`, state === 'working' ? '✳︎' : '')
  el.setAttribute('aria-hidden', 'true')
  return el
}

/** A session on a task, as the tab bar draws it: ✳, breathing, or the red dot. */
function sessionMark(s: TaskSessionView, withName = true): HTMLElement {
  const el = span('task-session-mark', '')
  const mark = span(
    `mark${s.alarm ? ' alarm' : s.working ? ' working' : s.running ? '' : ' faint'}`,
    s.alarm ? '' : s.agent ? '✳︎' : '❯'
  )
  el.append(mark)
  if (withName) el.append(text(s.name))
  return el
}

function askIcon(kind: TaskAsk['kind']): SVGSVGElement {
  const body =
    kind === 'review'
      ? '<circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4M12 10V7a3 3 0 0 0-3-3H7"/>'
      : '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/>'
  return svg(16, body, 'task-ask-icon')
}

function chevron(down: boolean, left = false): SVGSVGElement {
  const d = left ? 'M7.5 2.5L4 6l3.5 3.5' : down ? 'M2.5 4.5L6 8l3.5-3.5' : 'M4.5 2.5L8 6l-3.5 3.5'
  return svg(12, `<path d="${d}" stroke-linecap="round" stroke-linejoin="round"/>`, 'task-chevron')
}

function svg(size: number, body: string, cls: string): SVGSVGElement {
  const template = document.createElement('template')
  template.innerHTML =
    `<svg class="${cls}" width="${size === 16 ? 14 : size}" height="${size === 16 ? 14 : size}" viewBox="0 0 ${size} ${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${body}</svg>`
  return template.content.firstElementChild as SVGSVGElement
}

function div(cls: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = cls
  return el
}

function span(cls: string, content: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = cls
  el.textContent = content
  return el
}

function text(content: string): Text {
  return document.createTextNode(content)
}

function button(label: string, cls: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `task-button ${cls}`.trim()
  el.textContent = label
  return el
}

/** "now", "12 min", "3 h", "2 d". */
export function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}
