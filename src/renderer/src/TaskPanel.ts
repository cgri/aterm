import type { Task, TaskAction, TaskAsk, TaskEvent, TaskSession, TaskStep } from '@shared/types'
import { describeSource, isLink } from './taskSource'
import { taskRef } from '@shared/taskBriefing'
import { heldByBlock } from '@shared/taskSteps'

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

/**
 * How a step is shown. `done`, `later` and `blocked` follow from what is stored; a current
 * step is `waiting` when it is the user's turn - the step is theirs, or the session that
 * owns it waits at its prompt - `running` while that session works, `current` otherwise.
 */
export type StepShown = 'done' | 'current' | 'running' | 'waiting' | 'blocked' | 'later'

export interface TaskStepView {
  step: TaskStep
  shown: StepShown
  /** Who does it, as the panel names them: "You", a session, someone else. */
  owner: string
  /** The owning session's tab, while it is open. */
  tabId?: string
  /** The owning session, once its tab is closed - to resume it from here. */
  closed?: TaskSession
}

export interface TaskView {
  task: Task
  state: TaskShownState
  sessions: TaskSessionView[]
  /** The task's chain, in display order; empty for a task without steps. */
  steps: TaskStepView[]
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
  /** Puts a tab on the task, if it is not, and sends its session the task. */
  sendTo(task: Task, tabId: string): void
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

/** The narrowest the panel can be dragged: a number and a few words of a title. */
const MIN_WIDTH = 200

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
  private showActivity = false
  private showDoneSteps = false
  private signature = ''
  /** The opened task's fields, kept across rebuilds. */
  private detail?: {
    taskId: string
    title: HTMLTextAreaElement
    notes: HTMLTextAreaElement
    dynamic: HTMLDivElement
    notesTimer?: ReturnType<typeof setTimeout>
  }

  constructor(private readonly handlers: TaskPanelHandlers) {
    this.el = document.createElement('aside')
    this.el.className = 'task-panel'
    this.el.setAttribute('aria-label', 'Tasks')

    this.listView = div('task-list-view')
    // The filter and a square "+" in one row, and no heading: the button the panel opens
    // from says "Tasks" already.
    const head = div('task-head')
    this.filter = document.createElement('input')
    this.filter.className = 'task-filter'
    this.filter.placeholder = 'Filter · T7 · #61'
    this.filter.spellcheck = false
    this.filter.setAttribute('aria-label', 'Filter tasks')
    this.filter.addEventListener('input', () => this.rebuild())
    const add = button('', 'task-new primary')
    add.setAttribute('aria-label', 'New task')
    add.title = 'New task (Ctrl+Shift+K)'
    add.append(svg(12, '<path d="M6 1v10M1 6h10" stroke-linecap="round"/>', 'task-plus'))
    add.addEventListener('click', () => this.handlers.newTask())
    head.append(this.filter, add)

    this.list = div('task-list')
    this.listView.append(head, this.list)

    this.detailView = div('task-detail-view')
    this.detailView.hidden = true

    this.el.append(this.listView, this.detailView, this.makeResizer())
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

  /**
   * The grip on the panel's right edge. The width lives in a custom property on the panel
   * and in localStorage, so it is there again on the next start; the terminals beside it
   * refit through their own ResizeObserver, as they do for a window resize.
   */
  private makeResizer(): HTMLElement {
    const grip = div('task-resize')
    grip.setAttribute('aria-hidden', 'true')
    grip.title = 'Drag to resize'
    let stored: number | undefined
    try {
      stored = Number(localStorage.getItem('tasksWidth')) || undefined
    } catch {
      // The default width, then.
    }
    if (stored) this.setWidth(stored)

    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      grip.setPointerCapture(ev.pointerId)
      grip.classList.add('dragging')
      const left = this.el.getBoundingClientRect().left
      const move = (e: PointerEvent): void => this.setWidth(e.clientX - left)
      const up = (): void => {
        grip.classList.remove('dragging')
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.removeEventListener('pointercancel', up)
        try {
          localStorage.setItem('tasksWidth', String(Math.round(this.el.getBoundingClientRect().width)))
        } catch {
          // Kept for this run only.
        }
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
      grip.addEventListener('pointercancel', up)
    })
    // A double click puts it back to the width it started with.
    grip.addEventListener('dblclick', () => {
      this.el.style.removeProperty('--task-panel-width')
      try {
        localStorage.removeItem('tasksWidth')
      } catch {
        // Nothing to forget.
      }
    })
    return grip
  }

  /** Never narrower than a title can still be read in, never more than most of the window. */
  private setWidth(px: number): void {
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.6))
    const width = Math.round(Math.min(max, Math.max(MIN_WIDTH, px)))
    this.el.style.setProperty('--task-panel-width', `${width}px`)
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
      this.views.map((v) => [
        v.task,
        v.state,
        v.sessions.map((s) => [s.name, s.open, s.agent, s.running, s.working, s.waiting, s.alarm]),
        v.steps.map((s) => [s.shown, s.tabId, s.closed?.tabId])
      ]),
      this.ctx.current,
      this.openId,
      this.showDone,
      this.showActivity,
      this.showDoneSteps
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
    const byRef = this.views.filter((v) => taskRef(v.task).toLowerCase() === query)
    const matching =
      byRef.length > 0
        ? byRef
        : this.views.filter(
            (v) =>
              !query ||
              v.task.title.toLowerCase().includes(query) ||
              (v.task.source ?? '').toLowerCase().includes(query) ||
              (v.task.source ? describeSource(v.task.source).label.toLowerCase() === query : false)
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
      toggle.append(chevron(this.showDone), text(`Done · ${done.length}`))
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

  /**
   * One line per task: its number, its title, where it came from, and - for what is under
   * way - how long since anything happened. The section heading says the state, so a row
   * carries no mark of its own; only a task that needs the user gets colour and a second
   * line saying what for, and a blocked one a quiet second line saying what it waits for.
   * Who works on it is in the tooltip and the opened task.
   */
  private row(view: TaskView): HTMLElement {
    const { task, state } = view
    const row = button('', `task-row state-${state}${view.alarm ? ' alarm' : ''}`)
    row.addEventListener('click', () => this.show(task.id))
    const live = view.sessions.filter((s) => s.open).map((s) => s.name)
    row.title = [`${taskRef(task)}  ${task.title}`, ...(live.length ? [`On it: ${live.join(', ')}`] : [])].join('\n')

    const line = div('task-row-line')
    line.append(span('task-ref', taskRef(task)), span('task-title', task.title))
    if (task.source) line.append(span('task-source-ref', describeSource(task.source).label))
    if (state === 'needs_user' || state === 'working' || state === 'blocked') {
      line.append(span('task-age', ago(task.updatedAt)))
    }
    row.append(line)

    const reason = reasonLine(view)
    if (reason) row.append(reason)
    return row
  }

  private buildDetail(view: TaskView): void {
    const { task } = view
    if (this.detail?.taskId !== task.id) this.makeDetail(task)
    const detail = this.detail!
    if (document.activeElement !== detail.title) {
      detail.title.value = task.title
      fitHeight(detail.title)
    }
    if (document.activeElement !== detail.notes) detail.notes.value = task.notes ?? ''
    detail.dynamic.replaceChildren(...this.detailSections(view))
  }

  private makeDetail(task: Task): void {
    const back = button('', 'task-back')
    back.setAttribute('aria-label', 'Back to all tasks')
    back.append(chevron(false, true), text('Tasks'))
    back.addEventListener('click', () => this.back())

    // A textarea, so a long title wraps instead of being cut off; Enter still ends the edit.
    const title = document.createElement('textarea')
    title.className = 'task-title-input'
    title.rows = 1
    title.setAttribute('aria-label', 'Title')
    title.spellcheck = false
    title.addEventListener('input', () => fitHeight(title))
    title.addEventListener('change', () => this.handlers.act({ kind: 'edit', taskId: task.id, title: title.value }))
    title.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        title.blur()
      }
    })

    const notes = document.createElement('textarea')
    notes.className = 'task-notes'
    notes.rows = 3
    notes.placeholder = 'Notes — every session on this task reads them'
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
    const scroll = div('task-detail-scroll')
    // Notes sit between the live part and the activity, which `detailSections` puts into
    // the host after them; the notes themselves are never rebuilt, or typing would stop.
    scroll.append(dynamic, notes, div('task-activity-host'))

    const heading = div('task-title-row')
    heading.append(span('task-ref', taskRef(task)), title)
    this.detailView.replaceChildren(back, heading, scroll)
    this.detail = { taskId: task.id, title, notes, dynamic }
  }

  /**
   * What the opened task shows, in the list's own spirit: one primary action, everything
   * else a quiet link, and no box but where the user is asked for something.
   */
  private detailSections(view: TaskView): HTMLElement[] {
    const { task } = view
    const nodes: HTMLElement[] = []

    // State, who set it and when, and where the task came from - one line.
    const meta = div('task-meta')
    const chip = button('', `task-state-chip state-${view.state}`)
    chip.title = 'Change state'
    chip.append(text(STATE_LABELS[view.state]), chevron(true))
    chip.addEventListener('click', () => this.handlers.stateMenu(task, chip))
    meta.append(chip)
    if (task.source) {
      const src = describeSource(task.source)
      if (isLink(task.source)) {
        const a = document.createElement('a')
        a.className = 'task-source'
        a.href = task.source
        a.target = '_blank'
        a.rel = 'noreferrer'
        a.textContent = src.label
        a.title = src.description
        meta.append(a)
      } else meta.append(span('task-source', src.label))
    }
    const last = lastDeclared(task)
    if (last) meta.append(span('task-meta-by', `${last.by ? `${last.by} · ` : ''}${ago(last.at)}`))
    nodes.push(meta)

    // What the user is asked for: the one place with a frame around it. Questions, the
    // steps that are the user's turn, and - for a task without steps, which has nothing
    // else to go by - any session on it that waits without having said why. With steps, a
    // session waiting at its prompt is news only when the current step is its own.
    const asked = new Set(task.asks.map((a) => a.tabId).filter(Boolean))
    const yourTurn = task.doneAt ? [] : view.steps.filter((s) => s.shown === 'waiting')
    const silent =
      task.blocked || view.steps.length > 0
        ? []
        : view.sessions.filter((s) => s.open && s.waiting && !asked.has(s.session.tabId))
    if (task.asks.length > 0 || yourTurn.length > 0 || silent.length > 0) {
      const box = div('task-asks')
      for (const ask of task.asks) box.append(this.askItem(task, ask, view))
      for (const step of yourTurn) box.append(this.turnItem(task, step))
      for (const s of silent) {
        const item = div('task-ask')
        item.append(span('task-ask-kind', 'Waiting'), span('task-ask-text', `${s.name} is waiting for you.`))
        item.append(links(this.link('Go to tab', () => this.handlers.goToTab(s.session.tabId))))
        box.append(item)
      }
      nodes.push(box)
    }

    if (task.blocked && !task.doneAt) {
      const line = div('task-blocked')
      line.append(span('task-blocked-label', 'Blocked'), span('task-blocked-text', task.blocked))
      line.append(this.link('Unblock', () => this.handlers.act({ kind: 'setBlocked', taskId: task.id })))
      nodes.push(line)
    }

    if (view.steps.length > 0) nodes.push(this.stepsSection(task, view))

    // Who works on it, and the ways to put a session on it.
    const sessions = div('task-section')
    for (const s of [...view.sessions.filter((s) => s.open), ...view.sessions.filter((s) => !s.open)]) {
      sessions.append(this.sessionRow(task, s))
    }
    // Handing the task back to a session that is on it is what this view is mostly for, so
    // it is on that session's row ("Send"). What is left goes on one quiet line: with no
    // session yet, the two ways to start - the tab in front, or a new one - side by side;
    // with sessions, the rarer extras.
    const newSession = this.link('New session', () => this.handlers.startSession(task))
    newSession.title = task.cwd ? `A Claude tab in ${task.cwd}, told about this task` : 'A Claude tab, told about this task'
    const current = this.ctx.current
    const open = view.sessions.filter((s) => s.open)
    const currentFree = current && !open.some((s) => s.session.tabId === current.tabId) ? current : undefined
    const line = div('task-start-row')
    if (open.length === 0) {
      const start: HTMLElement[] = []
      if (currentFree?.claude) {
        const send = this.link(`Current tab (${currentFree.name})`, () => this.handlers.sendTo(task, currentFree.tabId))
        send.title = `Put “${currentFree.name}” on this task and send its session the task`
        start.push(send)
      }
      start.push(newSession)
      line.append(span('task-start-label', 'Start on it:'), links(...start))
    } else {
      const more: HTMLElement[] = [newSession]
      if (currentFree) {
        const attach = this.link('Attach current tab', () => this.handlers.attachCurrent(task))
        attach.title = `Put “${currentFree.name}” on this task without telling its session`
        more.push(attach)
      }
      if (open.length >= 2) {
        const group = this.link('Group tabs', () => this.handlers.groupTabs(task))
        group.title = 'Put the open tabs of this task into one tab group, named after it'
        more.push(group)
      }
      line.append(links(...more))
    }
    sessions.append(line)
    const folder = div('task-folder')
    folder.append(
      span('task-folder-path', task.cwd ? `in ${task.cwd}` : 'in the current tab’s folder'),
      this.link('Change', () => this.handlers.changeFolder(task))
    )
    folder.title = task.cwd ?? ''
    sessions.append(folder)
    nodes.push(sessions)

    // The activity goes below the notes, which are not rebuilt.
    const host = this.detailView.querySelector('.task-activity-host')
    if (host) host.replaceChildren(this.activity(task), this.footer(task))
    return nodes
  }

  private askItem(task: Task, ask: TaskAsk, view: TaskView): HTMLElement {
    const item = div('task-ask kind-question')
    item.append(span('task-ask-kind', `Question · ${ask.by ?? 'a session'} · ${ago(ask.at)}`), span('task-ask-text', ask.text))
    const actions: HTMLElement[] = []
    if (ask.url) actions.push(anchor('Open', ask.url))
    const tab = ask.tabId ? view.sessions.find((s) => s.session.tabId === ask.tabId && s.open) : undefined
    if (tab) actions.push(this.link('Go to tab', () => this.handlers.goToTab(tab.session.tabId)))
    actions.push(this.link('Mark answered', () => this.handlers.act({ kind: 'resolveAsk', taskId: task.id, askId: ask.id })))
    item.append(links(...actions))
    return item
  }

  /**
   * A step that is the user's turn, in the frame: one of their own (open the link, tick it
   * off), or a session's that waits at its prompt for a go (to its tab).
   */
  private turnItem(task: Task, view: TaskStepView): HTMLElement {
    const { step } = view
    const item = div('task-ask kind-step')
    const actions: HTMLElement[] = []
    if (step.owner.kind === 'user') {
      item.append(
        span(
          'task-ask-kind',
          `Your step ${step.id}${heldByBlock(task, step) ? ' · on hold while blocked' : ''}${step.by ? ` · ${step.by}` : ''} · ${ago(step.at)}`
        ),
        span('task-ask-text', step.note ? `${step.title} — ${step.note}` : step.title)
      )
      if (step.url) actions.push(anchor(urlLabel(step.url), step.url))
      actions.push(this.link('Mark done', () => this.setStepDone(task, step, true)))
    } else {
      item.append(
        span('task-ask-kind', `Step ${step.id} · ${view.owner} is waiting for your go`),
        span('task-ask-text', step.note ? `${step.title} — ${step.note}` : step.title)
      )
      if (view.tabId) actions.push(this.link('Go to tab', () => this.handlers.goToTab(view.tabId!)))
    }
    item.append(links(...actions))
    return item
  }

  /**
   * The chain: what is left, whose it is, in order. Done steps fold into one line - they
   * are history, and the open ones are what the user reads this for.
   */
  private stepsSection(task: Task, view: TaskView): HTMLElement {
    const box = div('task-section task-steps')
    const done = view.steps.filter((s) => s.shown === 'done')
    const head = div('task-steps-head')
    head.append(span('task-steps-label', 'Steps'), span('task-progress', `${done.length} of ${view.steps.length}`))
    // One grid for all rows, so owners and links line up in columns across steps.
    const rows = div('task-steps-grid')
    box.append(head, rows)
    if (done.length > 0 && !this.showDoneSteps) {
      const fold = button('', 'task-step task-steps-fold')
      fold.setAttribute('aria-expanded', 'false')
      fold.title = 'Show the done steps'
      // The ids share one span with the titles: "1–2, 4" does not fit the id column.
      const summary = span('task-step-title', '')
      summary.append(
        span('task-step-id', idRanges(done.map((s) => s.step.id))),
        text(`  ${done.map((s) => s.step.title).join(', ')}`)
      )
      fold.append(span('task-step-mark shown-done', '✓'), summary)
      fold.addEventListener('click', () => {
        this.showDoneSteps = true
        this.rebuild()
      })
      rows.append(fold)
    }
    for (const s of view.steps) {
      if (s.shown === 'done' && !this.showDoneSteps) continue
      rows.append(this.stepRow(task, s))
    }
    if (done.length > 0 && this.showDoneSteps) {
      const fold = this.link('Fold the done steps', () => {
        this.showDoneSteps = false
        this.rebuild()
      })
      fold.classList.add('task-steps-unfold')
      box.append(fold)
    }
    return box
  }

  /** One step: mark, number, title, owner (to their tab, or resumed), and what else it says. */
  private stepRow(task: Task, s: TaskStepView): HTMLElement {
    const { step } = s
    const row = div(`task-step shown-${s.shown}`)
    row.title = [`${step.id}  ${step.title}`, STEP_TITLES[s.shown], ...(step.note ? [step.note] : [])].join('\n')
    row.append(
      span(`task-step-mark shown-${s.shown}`, STEP_MARKS[s.shown]),
      span('task-step-id', String(step.id)),
      span('task-step-title', step.title)
    )

    const owner =
      s.tabId !== undefined
        ? this.link(s.owner, () => this.handlers.goToTab(s.tabId!))
        : s.closed?.claudeSessionId
          ? this.link(`${s.owner} (closed)`, () => this.handlers.resume(task, s.closed!))
          : span('task-step-owner-text', s.owner)
    owner.classList.add('task-step-owner')
    if (s.tabId) owner.title = `Go to ${s.owner}`
    else if (s.closed) owner.title = `Resume ${s.owner}`
    row.append(owner)

    // One thing more, the most useful: the link, what it is blocked on, what it waits for,
    // or its note.
    const extra = div('task-step-extra')
    const deps = step.after ?? []
    if (step.url) extra.append(anchor(`${urlLabel(step.url)} ↗`, step.url))
    else if (step.blocked) extra.append(text(step.blocked))
    else if (s.shown === 'later' && deps.length > 0) extra.append(text(`after ${deps.join(', ')}`))
    else if (step.note) extra.append(text(step.note))
    row.append(extra)

    const tick = button(s.shown === 'done' ? '↶' : '✓', 'task-step-tick')
    tick.title = s.shown === 'done' ? 'Not done after all' : 'Mark done'
    tick.setAttribute('aria-label', `${tick.title}: ${step.title}`)
    tick.addEventListener('click', () => this.setStepDone(task, step, s.shown !== 'done'))
    row.append(tick)
    return row
  }

  private setStepDone(task: Task, step: TaskStep, done: boolean): void {
    this.handlers.act({ kind: 'setStepDone', taskId: task.id, stepId: step.id, done })
  }

  /**
   * A session on the task, one line: its mark, its name and what it does. A click goes to
   * its tab - or resumes it, once the tab is closed; × takes it off the task.
   */
  private sessionRow(task: Task, s: TaskSessionView): HTMLElement {
    const row = div(`task-session${s.open ? '' : ' closed'}`)
    const main = button('', 'task-session-main')
    const what = !s.open
      ? 'closed'
      : s.alarm || s.waiting
        ? 'waiting'
        : s.working
          ? 'working'
          : s.running
            ? 'idle'
            : 'not started'
    main.append(sessionMark(s, false), span('task-session-name', s.name), span('task-session-sub', what))
    main.title = s.open ? `Go to ${s.name} (${s.folder})` : `Resume ${s.name} (${s.folder})`
    if (s.open) main.addEventListener('click', () => this.handlers.goToTab(s.session.tabId))
    else if (s.session.claudeSessionId) main.addEventListener('click', () => this.handlers.resume(task, s.session))
    else main.disabled = true
    // Giving the task back to this session: after a /clear, a restart, or a change of the
    // task's state, it may have lost sight of it. Only where a Claude session runs to hear it.
    if (s.open && s.running && s.agent) {
      const send = this.link('Send', () => this.handlers.sendTo(task, s.session.tabId))
      send.classList.add('task-send')
      send.title = `Send the task to “${s.name}”`
      row.append(send)
    }
    const detach = button('×', 'task-detach')
    detach.setAttribute('aria-label', `Take ${s.name} off this task`)
    detach.title = 'Take off this task'
    detach.addEventListener('click', () => this.handlers.act({ kind: 'leave', taskId: task.id, tabId: s.session.tabId }))
    row.append(main, detach)
    return row
  }

  /** A quiet action: text in the accent colour, no frame. */
  private link(label: string, run: () => void): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'task-link'
    el.textContent = label
    el.addEventListener('click', run)
    return el
  }

  /** The activity, folded away by default: it is a log to look things up in, not to read. */
  private activity(task: Task): HTMLElement {
    const box = div('task-section')
    const toggle = button('', 'task-done-toggle task-activity-toggle')
    toggle.setAttribute('aria-expanded', String(this.showActivity))
    toggle.append(chevron(this.showActivity), text(`Activity · ${task.activity.length}`))
    toggle.addEventListener('click', () => {
      this.showActivity = !this.showActivity
      this.rebuild()
    })
    box.append(toggle)
    if (!this.showActivity) return box
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
    const foot = div('task-footer')
    foot.append(
      this.link(task.doneAt ? 'Reopen' : 'Mark done', () =>
        this.handlers.act({ kind: 'setDone', taskId: task.id, done: !task.doneAt })
      )
    )
    const del = this.link('Delete task', () => {
      this.handlers.act({ kind: 'delete', taskId: task.id })
      this.back()
    })
    del.classList.add('danger')
    foot.append(del)
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

/** Grows a textarea to its content, so a title wraps onto as many lines as it needs. */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** A link that opens in the browser, looking like the quiet actions beside it. */
function anchor(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'task-link'
  a.href = href
  a.target = '_blank'
  a.rel = 'noreferrer'
  a.textContent = label
  a.title = href
  return a
}

/** What a step's link is called: "!60" or "#61" where the URL says, "Open" otherwise. */
function urlLabel(url: string): string {
  const { label } = describeSource(url)
  return /^[#!]\d+$/.test(label) ? label : 'Open'
}

/** 1,2,3,5 → "1–3, 5". */
function idRanges(ids: number[]): string {
  const out: string[] = []
  let start = ids[0]
  let prev = start
  for (const id of [...ids.slice(1), Number.NaN]) {
    if (id === prev + 1) {
      prev = id
      continue
    }
    out.push(start === prev ? String(start) : `${start}–${prev}`)
    start = id
    prev = id
  }
  return out.join(', ')
}

const STEP_TITLES: Record<StepShown, string> = {
  done: 'Done',
  current: 'Next',
  running: 'Being worked on',
  waiting: 'Your turn',
  blocked: 'Blocked',
  later: 'Later'
}

/** Quiet actions in a row, separated by a middle dot. */
function links(...items: HTMLElement[]): HTMLElement {
  const row = div('task-links')
  items.forEach((item, i) => {
    if (i > 0) row.append(span('task-links-sep', '·'))
    row.append(item)
  })
  return row
}

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

/**
 * The one line under a task's title that says why it is where it is. A question the user
 * is asked comes first; then, for a task with steps, the step that is next and whose it
 * is, with how far the chain has got; without steps, what it waits for.
 */
function reasonLine(view: TaskView): HTMLElement | undefined {
  const { task, state } = view
  if (state === 'done') return undefined
  const question = task.asks[task.asks.length - 1]
  if (state === 'needs_user' && question) {
    const line = div('task-reason needs')
    line.append(text(question.text))
    if (task.asks.length > 1) line.append(span('task-more', ` +${task.asks.length - 1}`))
    return line
  }
  const next = nextStep(view)
  if (next) {
    const line = div(`task-reason step shown-${next.shown}${state === 'needs_user' ? ' needs' : ''}`)
    const label = div('task-reason-text')
    label.append(span(`task-step-mark shown-${next.shown}`, STEP_MARKS[next.shown]), text(` ${next.step.title}`))
    label.append(span('task-reason-owner', ` · ${next.owner}`))
    const done = view.steps.filter((s) => s.shown === 'done').length
    line.append(label, span('task-progress', `${done}/${view.steps.length}`))
    return line
  }
  if (state === 'needs_user') {
    const waiting = view.sessions.find((s) => s.open && s.waiting)
    const line = div('task-reason needs')
    if (waiting) line.append(text(`${waiting.name} is waiting for you`))
    return line
  }
  if (state === 'blocked') {
    const line = div('task-reason blocked')
    line.textContent = task.blocked ?? ''
    return line
  }
  return undefined
}

/**
 * The step the list names for a task: the user's turn first, then what runs, then any
 * current step, then a blocked one - the most telling thing that can happen next.
 */
function nextStep(view: TaskView): TaskStepView | undefined {
  for (const shown of ['waiting', 'running', 'current', 'blocked'] as const) {
    const step = view.steps.find((s) => s.shown === shown)
    if (step) return step
  }
  return undefined
}

const STEP_MARKS: Record<StepShown, string> = {
  done: '✓',
  current: '●',
  running: '↻',
  waiting: '⏸',
  // U+FE0E asks for the text glyph: the emoji is red and ignores the mark's colour.
  blocked: '⛔︎',
  later: '○'
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
  head.textContent = `${label} · ${count}`
  return head
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
