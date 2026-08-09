import type { RecentSession } from '@shared/types'

export interface SessionPickerHandlers {
  /** Session in einem neuen Tab fortsetzen. */
  onOpen: (session: RecentSession) => void
  /** Session ist bereits offen → dorthin wechseln. */
  onFocus: (tabId: string) => void
  /** tabId der bereits offenen Session, falls vorhanden. */
  openTabFor: (sessionId: string) => string | undefined
}

/** Overlay „Zuletzt geöffnete Sessions" (Strg+Umschalt+O). */
export class SessionPicker {
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLDivElement
  private sessions: RecentSession[] = []
  private filtered: RecentSession[] = []
  private cursor = 0
  private open = false

  constructor(private readonly handlers: SessionPickerHandlers) {
    this.root = document.createElement('div')
    this.root.className = 'picker'

    const box = document.createElement('div')
    box.className = 'picker-box'

    this.input = document.createElement('input')
    this.input.placeholder = 'Session suchen (Titel oder Pfad)…'
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
    this.filtered = needle
      ? this.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)
        )
      : this.sessions
    this.renderList()
  }

  private renderList(): void {
    this.list.replaceChildren()

    if (this.filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'picker-empty'
      empty.textContent = this.sessions.length
        ? 'Keine Treffer.'
        : 'Keine Claude-Code-Sessions gefunden.'
      this.list.appendChild(empty)
      return
    }

    let lastCwd = ''
    this.filtered.slice(0, 200).forEach((session, index) => {
      if (session.cwd !== lastCwd) {
        lastCwd = session.cwd
        const group = document.createElement('div')
        group.className = 'picker-group'
        group.textContent = session.cwd
        this.list.appendChild(group)
      }

      const row = document.createElement('div')
      row.className = `picker-row${index === this.cursor ? ' selected' : ''}`

      const title = document.createElement('span')
      title.className = 'picker-title'
      title.textContent = session.title

      const meta = document.createElement('span')
      meta.className = 'picker-meta'
      const openTab = this.handlers.openTabFor(session.sessionId)
      meta.textContent = openTab
        ? 'offen'
        : `${formatWhen(session.lastUsed)} · ${session.promptCount} Prompts`
      if (openTab) meta.classList.add('is-open')

      row.append(title, meta)
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.choose(index)
      })
      this.list.appendChild(row)

      if (index === this.cursor) queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }))
    })
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.close()
    } else if (ev.key === 'ArrowDown') {
      this.cursor = Math.min(this.cursor + 1, this.filtered.length - 1)
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
    const session = this.filtered[index]
    if (!session) return
    this.close()
    const openTab = this.handlers.openTabFor(session.sessionId)
    if (openTab) this.handlers.onFocus(openTab)
    else this.handlers.onOpen(session)
  }
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} min`
  const hours = Math.round(min / 60)
  if (hours < 24) return `vor ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 30) return `vor ${days} d`
  return new Date(ts).toLocaleDateString('de-DE')
}
