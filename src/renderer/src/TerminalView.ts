import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'

const THEME = {
  background: '#12141a',
  foreground: '#d7dae2',
  cursor: '#4f8cff',
  selectionBackground: '#2f3b52'
}

/** Eine xterm.js-Instanz samt Container — genau eine je laufendem Tab. */
export class TerminalView {
  readonly element: HTMLDivElement
  readonly term: Terminal
  readonly search = new SearchAddon()
  private readonly fit = new FitAddon()
  private observer?: ResizeObserver

  constructor(
    readonly tabId: string,
    fontSize: number,
    private readonly onInput: (data: string) => void,
    private readonly onResize: (cols: number, rows: number) => void
  ) {
    this.element = document.createElement('div')
    this.element.className = 'term'

    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)

    // Ohne das hier rechnet xterm.js mit den Unicode-6-Breiten: Emoji wie ✅, ❌
    // oder 📁 gelten dort als eine Spalte breit, werden aber zwei Spalten breit
    // gezeichnet. Der Glyph überdeckt dann das folgende Leerzeichen, und der
    // Text klebt am Symbol. Unicode 11 kennt sie als doppelt breit.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'

    this.term.onData((data) => this.onInput(data))
  }

  open(parent: HTMLElement): void {
    parent.appendChild(this.element)
    this.term.open(this.element)

    try {
      this.term.loadAddon(new WebglAddon())
    } catch {
      // Ohne WebGL rendert xterm.js über das DOM weiter — nur langsamer.
    }

    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(this.element)
    this.refit()
  }

  /** Passt die PTY-Größe an die Fenstergröße an. Meldet nur echte Änderungen. */
  refit(): void {
    if (!this.element.isConnected || this.element.clientHeight === 0) return
    try {
      const dims = this.fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      if (dims.cols !== this.term.cols || dims.rows !== this.term.rows) {
        this.fit.fit()
        this.onResize(this.term.cols, this.term.rows)
      }
    } catch {
      // Während Layout-Umbauten kann proposeDimensions scheitern.
    }
  }

  size(): { cols: number; rows: number } {
    const dims = this.fit.proposeDimensions()
    return {
      cols: dims?.cols ?? this.term.cols,
      rows: dims?.rows ?? this.term.rows
    }
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size
    this.refit()
  }

  write(data: string): void {
    this.term.write(data)
  }

  writeLine(text: string): void {
    this.term.writeln(`\r\n\x1b[90m${text}\x1b[0m`)
  }

  focus(): void {
    this.term.focus()
  }

  dispose(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.term.dispose()
    this.element.remove()
  }
}
