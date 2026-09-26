import type { TabGroupColor } from '@shared/types'

export interface MenuItem {
  label: string
  /** A group's colour, drawn as a swatch in front of the label. */
  color?: TabGroupColor
  /** Put at the right end — a check mark against the choice already in force. */
  trailing?: string
  run: () => void
}

/**
 * The overlay behind a right-click on a tab or a group header, and the submenus
 * those open. It takes the focus while it is open, so the arrow keys navigate the
 * list instead of reaching the terminal; the keymap lets plain keys through to
 * it because it counts as an open overlay.
 */
export class ContextMenu {
  private readonly root: HTMLDivElement
  private readonly box: HTMLDivElement
  private readonly title: HTMLDivElement
  private readonly list: HTMLDivElement
  private items: MenuItem[] = []
  private cursor = 0
  private open = false

  /** Called after the overlay is gone, so the caller can take the focus back. */
  constructor(private readonly onClosed: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'picker menu'

    this.box = document.createElement('div')
    this.box.className = 'picker-box menu-box'
    // Focusable without being a tab stop — the overlay is opened, not tabbed into.
    this.box.tabIndex = -1

    this.title = document.createElement('div')
    this.title.className = 'picker-group'

    this.list = document.createElement('div')
    this.list.className = 'picker-list'

    this.box.append(this.title, this.list)
    this.root.appendChild(this.box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.close()
    })
    this.box.addEventListener('keydown', (ev) => this.onKey(ev))
  }

  isOpen(): boolean {
    return this.open
  }

  show(items: MenuItem[], title: string): void {
    if (items.length === 0) return
    this.title.textContent = title
    this.items = items
    this.cursor = 0
    this.renderList()
    this.root.classList.add('visible')
    this.open = true
    this.box.focus()
  }

  close(): void {
    if (!this.open) return
    this.root.classList.remove('visible')
    this.open = false
    this.onClosed()
  }

  private renderList(): void {
    this.list.replaceChildren()

    this.items.forEach((item, index) => {
      const row = document.createElement('div')
      row.className = `picker-row${index === this.cursor ? ' selected' : ''}`
      // Built from elements rather than written as text, because a row may carry a
      // colour swatch and a check mark besides its label.
      row.replaceChildren(...rowParts(item))
      // The pointer moves the cursor too, so mouse and keyboard never disagree.
      row.addEventListener('mousemove', () => this.setCursor(index))
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.choose(index)
      })
      this.list.appendChild(row)
    })
  }

  private setCursor(index: number): void {
    this.cursor = index
    ;[...this.list.children].forEach((row, i) => {
      row.classList.toggle('selected', i === index)
    })
  }

  private onKey(ev: KeyboardEvent): void {
    const last = this.items.length - 1
    const down = ev.key === 'ArrowDown' || (ev.key === 'Tab' && !ev.shiftKey)
    const up = ev.key === 'ArrowUp' || (ev.key === 'Tab' && ev.shiftKey)

    if (ev.key === 'Escape') this.close()
    else if (down) this.setCursor(this.cursor === last ? 0 : this.cursor + 1)
    else if (up) this.setCursor(this.cursor === 0 ? last : this.cursor - 1)
    else if (ev.key === 'Home') this.setCursor(0)
    else if (ev.key === 'End') this.setCursor(last)
    else if (ev.key === 'Enter' || ev.key === ' ') this.choose(this.cursor)
    else return

    ev.preventDefault()
    ev.stopPropagation()
  }

  private choose(index: number): void {
    const item = this.items[index]
    if (!item) return
    this.close()
    item.run()
  }
}

function rowParts(item: MenuItem): HTMLElement[] {
  const parts: HTMLElement[] = []

  if (item.color) {
    const swatch = document.createElement('span')
    swatch.className = 'picker-swatch'
    swatch.dataset.groupColor = item.color
    parts.push(swatch)
  }

  const label = document.createElement('span')
  label.className = 'picker-label'
  label.textContent = item.label
  parts.push(label)

  if (item.trailing) {
    const trailing = document.createElement('span')
    trailing.className = 'picker-trailing'
    trailing.textContent = item.trailing
    parts.push(trailing)
  }

  return parts
}
