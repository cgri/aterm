import type { TerminalView } from './TerminalView'

/** Scrollback search (Ctrl+Shift+F). Enter for next, Shift+Enter for previous. */
export class SearchBar {
  private readonly el: HTMLDivElement
  private readonly input: HTMLInputElement
  private host?: HTMLElement

  constructor(private readonly view: () => TerminalView | undefined) {
    this.el = document.createElement('div')
    this.el.className = 'searchbar'

    this.input = document.createElement('input')
    this.input.placeholder = 'Search…'
    this.input.addEventListener('input', () => this.find(true))
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this.detach()
      } else if (ev.key === 'Enter') {
        this.find(!ev.shiftKey)
      } else {
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
    })

    const close = document.createElement('span')
    close.className = 'key'
    close.textContent = 'Esc'
    close.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      this.detach()
    })

    this.el.append(this.input, close)
  }

  isOpen(): boolean {
    return Boolean(this.host)
  }

  toggle(pane: HTMLElement | undefined): void {
    if (this.host) this.detach()
    else if (pane) this.attach(pane)
  }

  private attach(pane: HTMLElement): void {
    this.host = pane
    pane.appendChild(this.el)
    this.input.value = ''
    this.input.focus()
  }

  detach(): void {
    if (!this.host) return
    this.el.remove()
    this.host = undefined
    this.view()?.focus()
  }

  private find(forward: boolean): void {
    const needle = this.input.value
    const search = this.view()?.search
    if (!search || !needle) return
    if (forward) search.findNext(needle)
    else search.findPrevious(needle)
  }
}
