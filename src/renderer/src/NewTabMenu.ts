export interface MenuItem {
  label: string
  run: () => void
}

/**
 * The "new tab" overlay behind "+" and Ctrl+T — same shape as the session
 * picker. It takes the focus while it is open, so the arrow keys navigate the
 * list instead of reaching the terminal; the keymap lets plain keys through to
 * it because it counts as an open overlay.
 */
export class NewTabMenu {
  private readonly root: HTMLDivElement
  private readonly box: HTMLDivElement
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

    const title = document.createElement('div')
    title.className = 'picker-group'
    title.textContent = 'New tab'

    this.list = document.createElement('div')
    this.list.className = 'picker-list'

    this.box.append(title, this.list)
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

  show(items: MenuItem[]): void {
    if (items.length === 0) return
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
      row.textContent = item.label
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
