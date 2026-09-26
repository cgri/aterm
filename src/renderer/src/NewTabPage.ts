import type { RecentSession, TabKind } from '@shared/types'
import { icon } from './icons'
import { projectDir, worktreeName } from './paths'

export interface NewTabPageHandlers {
  /** Start a fresh tab of this kind in `cwd`. */
  start: (kind: TabKind, cwd: string, opts?: { worktree?: boolean }) => void
  /** Ask for a folder first, then start a tab of this kind there. */
  startInFolder: (kind: TabKind) => void
  /** Resume the session in a new tab. */
  open: (session: RecentSession) => void
  /** The session is already open → switch to it. */
  focusTab: (tabId: string) => void
  /** tabId of the already open session, if there is one. */
  openTabFor: (sessionId: string) => string | undefined
  /** Esc on an empty search: close the page and go back to the tab before it. */
  back: () => void
}

/** What the page offers to start in, fixed for as long as it is open. */
export interface NewTabPageContext {
  /** The folder "current folder" means — the tab in front when the page opened. */
  cwd: string
}

/** One selectable thing on the page: a start option, a "New session" or a session. */
interface Entry {
  el: HTMLElement
  run: () => void
  /** Only sessions are what typing moves the selection to. */
  session?: boolean
}

type Column = 'start' | 'sessions'

/** At most this many sessions are listed — counted before the rows are built. */
const MAX_SESSIONS = 200

const AGENT_MARK = '✳︎'
const SHELL_MARK = '❯'

/**
 * What "+", Ctrl+T and Ctrl+Shift+O open, and what an empty window shows: a page of
 * its own, with a tab of its own, holding the ways to start a tab on the left and the
 * sessions Claude Code has run on the right.
 *
 * There is one selection on the page, never one per column, and the keyboard never
 * leaves the search field for it: Up and Down move within the column the selection is
 * in, Tab and Shift+Tab take it across, and Left and Right stay with the field's caret.
 * A click anywhere on the page runs what it hit without taking the focus away from the
 * field, so the keys keep working after the mouse was used.
 */
export class NewTabPage {
  readonly element: HTMLDivElement
  private readonly scroll: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly count: HTMLSpanElement
  private readonly startHost: HTMLDivElement
  private readonly sessionsHost: HTMLDivElement
  private readonly sessionsLabel: HTMLDivElement
  private readonly escHint: HTMLSpanElement

  private context: NewTabPageContext = { cwd: '' }
  private canWorktree = false
  private sessions: RecentSession[] = []
  /** Until the list has arrived, an empty one says nothing about the sessions. */
  private loaded = false
  private canGoBack = false
  /** Which `open` the data being loaded belongs to — a newer one wins. */
  private generation = 0

  private start: Entry[] = []
  private list: Entry[] = []
  private column: Column = 'start'
  private startCursor = 0
  private listCursor = 0

  constructor(
    host: HTMLElement,
    private readonly handlers: NewTabPageHandlers
  ) {
    this.element = document.createElement('div')
    this.element.className = 'ntp'

    const scroll = document.createElement('div')
    scroll.className = 'ntp-scroll'
    this.scroll = scroll
    const body = document.createElement('div')
    body.className = 'ntp-body'

    const search = document.createElement('label')
    search.className = 'ntp-search'
    this.input = document.createElement('input')
    this.input.placeholder = 'Search sessions by title or folder'
    this.input.setAttribute('aria-label', 'Search sessions')
    this.input.spellcheck = false
    this.count = document.createElement('span')
    this.count.className = 'ntp-count'
    search.append(icon('search'), this.input, this.count)

    const columns = document.createElement('div')
    columns.className = 'ntp-columns'

    const startColumn = document.createElement('section')
    startColumn.className = 'ntp-start'
    this.startHost = document.createElement('div')
    this.startHost.className = 'ntp-start-list'
    startColumn.appendChild(this.startHost)

    const sessionsColumn = document.createElement('section')
    sessionsColumn.className = 'ntp-sessions'
    this.sessionsLabel = document.createElement('div')
    this.sessionsLabel.className = 'ntp-label'
    this.sessionsHost = document.createElement('div')
    sessionsColumn.append(this.sessionsLabel, this.sessionsHost)

    columns.append(startColumn, sessionsColumn)
    body.append(search, columns)
    scroll.appendChild(body)

    const hints = document.createElement('div')
    hints.className = 'ntp-hints'
    this.escHint = document.createElement('span')
    hints.append(
      hint(['↑', '↓'], 'move'),
      hint(['Tab'], 'other column'),
      hint(['Enter'], 'open'),
      this.escHint
    )

    this.element.append(scroll, hints)
    host.appendChild(this.element)

    this.input.addEventListener('input', () => this.applyFilter(true))
    this.input.addEventListener('keydown', (ev) => this.onKey(ev))
    // The field keeps the keyboard: a click elsewhere on the page still runs what it
    // hit, it just does not move the focus there.
    this.element.addEventListener('mousedown', (ev) => {
      if (ev.target === this.input) return
      ev.preventDefault()
      this.input.focus()
    })
  }

  isVisible(): boolean {
    return this.element.classList.contains('visible')
  }

  /**
   * A fresh page: the search is emptied and the selection goes back to the first way
   * to start a tab, so Ctrl+T, Enter still does what it always did. What it lists is
   * loaded behind the page, which is up and taking keys straight away.
   */
  open(context: NewTabPageContext): void {
    this.context = context
    this.canWorktree = false
    this.sessions = []
    this.loaded = false
    this.input.value = ''
    this.column = 'start'
    this.startCursor = 0
    this.listCursor = 0
    this.renderStart()
    this.renderEscHint()
    this.reveal()
    this.scroll.scrollTop = 0

    const generation = ++this.generation
    void Promise.all([
      window.aterm.system.isGitRepo(context.cwd),
      window.aterm.sessions.recent()
    ]).then(([canWorktree, sessions]) => {
      if (generation !== this.generation) return
      this.canWorktree = canWorktree
      this.sessions = sessions
      this.loaded = true
      this.renderStart()
      this.applyFilter(false)
    })
  }

  /**
   * Back to a page that was left open behind another tab: it is as it was left, only
   * which sessions are open in a tab may have changed meanwhile.
   */
  reveal(): void {
    this.applyFilter(false)
    this.element.classList.add('visible')
    this.focus()
  }

  hide(): void {
    this.element.classList.remove('visible')
  }

  focus(): void {
    this.input.focus()
  }

  /** Whether there is a tab to go back to; without one Esc has nothing to do. */
  setCanGoBack(canGoBack: boolean): void {
    if (this.canGoBack === canGoBack) return
    this.canGoBack = canGoBack
    this.renderEscHint()
  }

  /* ------------------------------------------------------------ Start */

  private renderStart(): void {
    const { cwd } = this.context
    this.start = []
    this.startHost.replaceChildren()

    const head = document.createElement('div')
    head.className = 'ntp-start-head'
    const label = document.createElement('span')
    label.className = 'ntp-label'
    label.textContent = 'Start new'
    const where = document.createElement('span')
    where.className = 'ntp-path'
    where.textContent = `in ${cwd}`
    where.title = cwd
    head.append(label, where)
    this.startHost.appendChild(head)

    this.addKind('Claude Code', AGENT_MARK, [
      ['Current folder', () => this.handlers.start('claude', cwd)],
      // `claude --worktree` needs a git working tree; offering it anywhere else would
      // just open a tab that dies with an error.
      ...(this.canWorktree
        ? [
            ['New worktree', () => this.handlers.start('claude', cwd, { worktree: true })] as const
          ]
        : []),
      ['Choose folder…', () => this.handlers.startInFolder('claude')]
    ])
    this.addKind('PowerShell', SHELL_MARK, [
      ['Current folder', () => this.handlers.start('powershell', cwd)],
      ['Choose folder…', () => this.handlers.startInFolder('powershell')]
    ])

    this.startCursor = Math.min(this.startCursor, this.start.length - 1)
    this.paintSelection()
  }

  private addKind(
    name: string,
    mark: string,
    options: ReadonlyArray<readonly [string, () => void]>
  ): void {
    const block = document.createElement('div')
    block.className = 'ntp-kind'
    const heading = document.createElement('div')
    heading.className = 'ntp-kind-name'
    heading.textContent = name
    block.appendChild(heading)

    for (const [label, run] of options) {
      const row = button('ntp-option')
      const glyph = document.createElement('span')
      glyph.className = 'ntp-mark'
      glyph.textContent = mark
      const text = document.createElement('span')
      text.className = 'ntp-option-label'
      text.textContent = label
      row.append(glyph, text)
      block.appendChild(row)
      this.addEntry('start', { el: row, run })
    }
    this.startHost.appendChild(block)
  }

  /* --------------------------------------------------------- Sessions */

  /**
   * `typed` says the search text changed. Typing moves the selection to the first
   * session that matches — that is what the typing was for — and emptying the field
   * puts it back on the first way to start a tab. Anything else leaves it where it is.
   */
  private applyFilter(typed: boolean): void {
    const needle = this.input.value.trim().toLowerCase()
    const matches = needle
      ? this.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)
        )
      : this.sessions

    // Grouped by repository, not by the directory Claude Code ran in: a worktree
    // session belongs to its project. The sessions arrive in recency order and keep it
    // inside a block, and a Map keeps its keys in the order they were first seen — so
    // the blocks are sorted by their most recent session without being sorted again.
    const groups = new Map<string, RecentSession[]>()
    for (const session of matches.slice(0, MAX_SESSIONS)) {
      const project = projectDir(session.cwd)
      const group = groups.get(project)
      if (group) group.push(session)
      else groups.set(project, [session])
    }

    this.list = []
    this.sessionsHost.replaceChildren()
    for (const [project, sessions] of groups) this.addGroup(project, sessions, needle)

    if (this.list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ntp-empty'
      empty.textContent = needle
        ? `No session matches “${this.input.value.trim()}”.`
        : this.loaded && this.sessions.length === 0
          ? 'No Claude Code sessions yet.'
          : ''
      this.sessionsHost.appendChild(empty)
    }

    this.sessionsLabel.textContent = needle ? 'Matching sessions' : 'Recent sessions'
    this.count.textContent = needle ? `${matches.length} of ${this.sessions.length}` : ''

    if (typed) {
      this.scroll.scrollTop = 0
      const first = this.list.findIndex((entry) => entry.session)
      if (needle && first >= 0) {
        this.column = 'sessions'
        this.listCursor = first
      } else {
        this.column = 'start'
        if (!needle) this.startCursor = 0
      }
      this.renderEscHint()
    }
    this.listCursor = Math.max(0, Math.min(this.listCursor, this.list.length - 1))
    if (this.list.length === 0) this.column = 'start'
    this.paintSelection(typed)
  }

  private addGroup(project: string, sessions: RecentSession[], needle: string): void {
    const block = document.createElement('div')
    block.className = 'ntp-group'

    const head = document.createElement('div')
    head.className = 'ntp-group-head'
    const path = document.createElement('span')
    path.className = 'ntp-path'
    path.textContent = project
    path.title = project
    // It belongs to the project rather than to any one session, so it sits in the
    // project's header — first in the block, which is also where Up and Down meet it.
    const fresh = button('ntp-new')
    fresh.append(icon('plus'), 'New session')
    head.append(path, fresh)
    block.appendChild(head)
    this.addEntry('sessions', { el: fresh, run: () => this.handlers.start('claude', project) })

    for (const session of sessions) {
      const row = this.sessionRow(session, needle)
      block.appendChild(row)
      this.addEntry('sessions', {
        el: row,
        session: true,
        run: () => {
          const openTab = this.handlers.openTabFor(session.sessionId)
          if (openTab) this.handlers.focusTab(openTab)
          else this.handlers.open(session)
        }
      })
    }
    this.sessionsHost.appendChild(block)
  }

  private sessionRow(session: RecentSession, needle: string): HTMLButtonElement {
    const row = button('ntp-row')

    const title = document.createElement('span')
    title.className = 'ntp-title'
    const at = needle ? session.title.toLowerCase().indexOf(needle) : -1
    if (at < 0) {
      title.textContent = session.title
    } else {
      const hit = document.createElement('mark')
      hit.textContent = session.title.slice(at, at + needle.length)
      title.append(session.title.slice(0, at), hit, session.title.slice(at + needle.length))
    }
    row.appendChild(title)

    // Which worktree — the header names the project, so this is what tells two
    // sessions of one project apart.
    const worktree = worktreeName(session.cwd)
    if (worktree) {
      const inWorktree = document.createElement('span')
      inWorktree.className = 'ntp-worktree'
      inWorktree.textContent = worktree
      row.appendChild(inWorktree)
    }

    const meta = document.createElement('span')
    meta.className = 'ntp-meta'
    if (this.handlers.openTabFor(session.sessionId)) {
      meta.textContent = 'open'
      meta.classList.add('is-open')
    } else {
      meta.textContent = `${formatWhen(session.lastUsed)} · ${session.promptCount} prompts`
    }
    row.appendChild(meta)
    return row
  }

  /* -------------------------------------------------------- Selection */

  private addEntry(column: Column, entry: Entry): void {
    const entries = column === 'start' ? this.start : this.list
    const index = entries.length
    entries.push(entry)
    entry.el.addEventListener('click', () => {
      this.column = column
      if (column === 'start') this.startCursor = index
      else this.listCursor = index
      this.paintSelection()
      entry.run()
    })
  }

  /**
   * `reveal` scrolls the selection into view, and only a selection the user moved asks
   * for that: a redraw — the lists arriving, the page coming back — leaves the view
   * where it is.
   */
  private paintSelection(reveal = false): void {
    this.start.forEach((entry, i) => {
      entry.el.classList.toggle('selected', this.column === 'start' && i === this.startCursor)
    })
    this.list.forEach((entry, i) => {
      entry.el.classList.toggle('selected', this.column === 'sessions' && i === this.listCursor)
    })
    if (reveal) this.selected()?.el.scrollIntoView({ block: 'nearest' })
  }

  private selected(): Entry | undefined {
    return this.column === 'start' ? this.start[this.startCursor] : this.list[this.listCursor]
  }

  private move(delta: number): void {
    if (this.column === 'start') {
      this.startCursor = clamp(this.startCursor + delta, this.start.length)
    } else {
      this.listCursor = clamp(this.listCursor + delta, this.list.length)
    }
    this.paintSelection(true)
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown') this.move(1)
    else if (ev.key === 'ArrowUp') this.move(-1)
    else if (ev.key === 'Tab') {
      // Two columns, so forwards and backwards are the same step. An empty list
      // leaves nothing to go over to.
      if (this.column === 'start' && this.list.length > 0) this.column = 'sessions'
      else this.column = 'start'
      this.paintSelection(true)
    } else if (ev.key === 'Enter') this.selected()?.run()
    else if (ev.key === 'Escape') {
      if (this.input.value) {
        this.input.value = ''
        this.applyFilter(true)
      } else {
        this.handlers.back()
      }
    } else return

    ev.preventDefault()
    ev.stopPropagation()
  }

  private renderEscHint(): void {
    const text = this.input.value ? 'clear search' : this.canGoBack ? 'back' : ''
    this.escHint.replaceChildren(...(text ? [hint(['Esc'], text)] : []))
  }
}

/**
 * Not a tab stop: the search field keeps the keyboard, and the page's own mousedown
 * handler keeps a click from moving the focus here.
 */
function button(className: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.tabIndex = -1
  el.className = className
  return el
}

function hint(keys: string[], label: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'ntp-hint'
  for (const key of keys) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    el.appendChild(kbd)
  }
  el.append(label)
  return el
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1))
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(ts).toLocaleDateString('en-GB')
}
