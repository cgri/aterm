export interface MenuItem {
  label: string
  run: () => void
}

/**
 * The menu behind "+" and Ctrl+T. It takes the focus while it is open, so the
 * arrow keys navigate the menu instead of reaching the terminal — the keymap
 * lets plain keys through to it because it counts as an open overlay.
 */
export class NewTabMenu {
  private root?: HTMLDivElement
  private items: MenuItem[] = []
  private cursor = 0

  /** Called after the menu is gone, so the caller can take the focus back. */
  constructor(private readonly onClosed: () => void) {}

  isOpen(): boolean {
    return Boolean(this.root)
  }

  open(anchor: DOMRect, items: MenuItem[]): void {
    this.close()
    if (items.length === 0) return

    this.items = items
    this.cursor = 0

    const root = document.createElement('div')
    root.className = 'menu'
    // Focusable without being a tab stop — the menu is opened, not tabbed into.
    root.tabIndex = -1
    root.style.top = `${anchor.bottom + 2}px`
    root.style.left = `${Math.max(4, anchor.left - 200)}px`
    root.addEventListener('keydown', (ev) => this.onKey(ev))
    this.root = root

    items.forEach((item, index) => {
      const el = document.createElement('div')
      el.className = `item${index === this.cursor ? ' selected' : ''}`
      el.textContent = item.label
      // The pointer moves the cursor too, so mouse and keyboard never disagree.
      el.addEventListener('mousemove', () => this.setCursor(index))
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.choose(index)
      })
      root.appendChild(el)
    })

    document.body.appendChild(root)
    document.addEventListener('mousedown', this.onOutsideMouseDown, true)
    root.focus()
  }

  close(): void {
    if (!this.root) return
    document.removeEventListener('mousedown', this.onOutsideMouseDown, true)
    this.root.remove()
    this.root = undefined
    this.onClosed()
  }

  private readonly onOutsideMouseDown = (ev: MouseEvent): void => {
    if (!this.root?.contains(ev.target as Node)) this.close()
  }

  private setCursor(index: number): void {
    this.cursor = index
    ;[...(this.root?.children ?? [])].forEach((el, i) => {
      el.classList.toggle('selected', i === index)
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
