import type { RecentSession } from '@shared/types'
import { projectDir, worktreeName } from './paths'

export interface SessionPickerHandlers {
  /** Resume the session in a new tab. */
  onOpen: (session: RecentSession) => void
  /** Start a fresh session in the project the row belongs to. */
  onNew: (cwd: string) => void
  /** The session is already open → switch to it. */
  onFocus: (tabId: string) => void
  /** tabId of the already open session, if there is one. */
  openTabFor: (sessionId: string) => string | undefined
}

/**
 * One row of the list. The cursor indexes these rather than the sessions,
 * because not every row is a session.
 */
type PickerItem =
  | { kind: 'session'; session: RecentSession }
  | { kind: 'new'; project: string }

/** At most this many sessions are listed — counted before the rows are built. */
const MAX_SESSIONS = 200

/** The "recently opened sessions" overlay (Ctrl+Shift+O). */
export class SessionPicker {
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLDivElement
  private sessions: RecentSession[] = []
  private items: PickerItem[] = []
  private cursor = 0
  private open = false

  constructor(private readonly handlers: SessionPickerHandlers) {
    this.root = document.createElement('div')
    this.root.className = 'picker'

    const box = document.createElement('div')
    box.className = 'picker-box'

    this.input = document.createElement('input')
    this.input.placeholder = 'Search sessions (title or path)…'
    this.input.addEventListener('input', () => {
      this.cursor = 0
      this.applyFilter()
    })

    this.list = document.createElement('div')
    this.list.className = 'picker-list'

    box.append(this.input, this.list)
    this.root.appendChild(box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.close()
    })
    this.input.addEventListener('keydown', (ev) => this.onKey(ev))
  }

  isOpen(): boolean {
    return this.open
  }

  async show(): Promise<void> {
    this.sessions = await window.aterm.sessions.recent()
    this.cursor = 0
    this.input.value = ''
    this.applyFilter()
    this.root.classList.add('visible')
    this.open = true
    this.input.focus()
  }

  close(): void {
    this.root.classList.remove('visible')
    this.open = false
  }

  private applyFilter(): void {
    const needle = this.input.value.trim().toLowerCase()
    const matches = needle
      ? this.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)
        )
      : this.sessions

    // Grouped by repository, not by the directory Claude Code ran in: a worktree
    // session belongs to its project, and filing it under the worktree path would
    // scatter one project's sessions over as many headers as it has worktrees.
    // A project gets one block, so that starting a new session there has one place
    // to live. The sessions arrive in recency order and keep it inside a block, and
    // a Map keeps the order its keys were first seen in — so the blocks end up
    // sorted by their most recent session without being sorted again.
    const groups = new Map<string, RecentSession[]>()
    for (const session of matches.slice(0, MAX_SESSIONS)) {
      const project = projectDir(session.cwd)
      const group = groups.get(project)
      if (group) group.push(session)
      else groups.set(project, [session])
    }

    this.items = []
    for (const [project, sessions] of groups) {
      for (const session of sessions) this.items.push({ kind: 'session', session })
      // Last in the block, not first: it belongs to the project rather than to any
      // one session, and a past session is the more common reason to open the list.
      this.items.push({ kind: 'new', project })
    }

    this.renderList()
  }

  private renderList(): void {
    this.list.replaceChildren()

    if (this.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'picker-empty'
      empty.textContent = this.sessions.length
        ? 'No matches.'
        : 'No Claude Code sessions found.'
      this.list.appendChild(empty)
      return
    }

    let lastGroup = ''
    this.items.forEach((item, index) => {
      // The new-session row carries the same key as the sessions above it, so it
      // closes the block instead of opening a second one.
      const project = item.kind === 'new' ? item.project : projectDir(item.session.cwd)
      if (project !== lastGroup) {
        lastGroup = project
        const group = document.createElement('div')
        group.className = 'picker-group'
        group.textContent = project
        this.list.appendChild(group)
      }

      const row = item.kind === 'new' ? newRow() : this.sessionRow(item.session)
      if (index === this.cursor) row.classList.add('selected')

      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.choose(index)
      })
      this.list.appendChild(row)

      if (index === this.cursor) queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }))
    })
  }

  private sessionRow(session: RecentSession): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'picker-row'

    const title = document.createElement('span')
    title.className = 'picker-title'
    title.textContent = session.title

    const meta = document.createElement('span')
    meta.className = 'picker-meta'
    const openTab = this.handlers.openTabFor(session.sessionId)
    meta.textContent = openTab
      ? 'open'
      : `${formatWhen(session.lastUsed)} · ${session.promptCount} prompts`
    if (openTab) meta.classList.add('is-open')

    row.append(title)
    // Which worktree, now that the header no longer says so. Its own element
    // and not part of the meta, which an already open session takes over.
    const worktree = worktreeName(session.cwd)
    if (worktree) {
      const inWorktree = document.createElement('span')
      inWorktree.className = 'picker-worktree'
      inWorktree.textContent = worktree
      row.append(inWorktree)
    }
    row.append(meta)
    return row
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.close()
    } else if (ev.key === 'ArrowDown') {
      this.cursor = Math.min(this.cursor + 1, this.items.length - 1)
      this.renderList()
    } else if (ev.key === 'ArrowUp') {
      this.cursor = Math.max(this.cursor - 1, 0)
      this.renderList()
    } else if (ev.key === 'Enter') {
      this.choose(this.cursor)
    } else {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
  }

  private choose(index: number): void {
    const item = this.items[index]
    if (!item) return
    this.close()

    if (item.kind === 'new') {
      this.handlers.onNew(item.project)
      return
    }

    const openTab = this.handlers.openTabFor(item.session.sessionId)
    if (openTab) this.handlers.onFocus(openTab)
    else this.handlers.onOpen(item.session)
  }
}

/** Starts a conversation instead of continuing one — the header names where. */
function newRow(): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'picker-row picker-new'

  const title = document.createElement('span')
  title.className = 'picker-title'
  title.textContent = 'New session'

  row.append(title)
  return row
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
