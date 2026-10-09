import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Appearance } from '@shared/types'

/**
 * The dark theme leaves the ANSI palette to xterm.js, whose default is built for
 * a dark background. On a light background those colours are barely readable, so
 * the light theme brings all sixteen of its own.
 */
const THEMES: Record<Appearance, ITheme> = {
  dark: {
    background: '#12141a',
    foreground: '#d7dae2',
    cursor: '#4f8cff',
    selectionBackground: '#2f3b52'
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2430',
    cursor: '#1a6fe0',
    selectionBackground: '#cfe0ff',
    black: '#24292e',
    red: '#d1242f',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#135e6c',
    brightWhite: '#24292e'
  }
}

/** One xterm.js instance and its container — exactly one per running tab. */
export class TerminalView {
  readonly element: HTMLDivElement
  readonly term: Terminal
  readonly search = new SearchAddon()
  private readonly fit = new FitAddon()
  private observer?: ResizeObserver
  private webgl?: WebglAddon
  // A view is opened for the tab in front.
  private visible = true

  constructor(
    readonly tabId: string,
    fontSize: number,
    appearance: Appearance,
    private readonly onInput: (data: string) => void,
    private readonly onResize: (cols: number, rows: number) => void,
    private readonly onTitle: (title: string) => void
  ) {
    this.element = document.createElement('div')
    this.element.className = 'term'

    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEMES[appearance]
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)

    // Without this, xterm.js uses Unicode 6 widths, where emoji such as ✅, ❌ or
    // 📁 count as one column wide although they are drawn two columns wide. The
    // glyph then covers the following space and the text ends up glued to the
    // symbol. Unicode 11 knows them as double width.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'

    this.term.onData((data) => this.onInput(data))
    // OSC 0 / OSC 2 — how a program names its own window. Claude Code keeps this
    // up to date with whatever it is working on.
    this.term.onTitleChange((title) => this.onTitle(title))
  }

  open(parent: HTMLElement): void {
    parent.appendChild(this.element)
    this.term.open(this.element)
    this.attachWebgl()

    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(this.element)
    this.refit()
  }

  /**
   * A WebGL context can be taken away — Chromium drops the oldest once a page holds
   * about sixteen, and a GPU reset drops them all. The addon then draws nothing until
   * it is disposed, which hands the terminal back to the DOM renderer. Only the tab in
   * front holds a context, so the limit is never reached; one lost there anyway is a
   * GPU reset, and a new context is taken at once.
   */
  private attachWebgl(): void {
    if (this.webgl || !this.visible) return
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        if (this.webgl !== webgl) return
        this.detachWebgl()
        this.attachWebgl()
      })
      this.term.loadAddon(webgl)
      this.webgl = webgl
    } catch {
      // Without WebGL, xterm.js keeps rendering through the DOM — just slower.
    }
  }

  private detachWebgl(): void {
    const webgl = this.webgl
    this.webgl = undefined
    webgl?.dispose()
  }

  /** The tab came to the front. */
  show(): void {
    this.visible = true
    this.attachWebgl()
    this.refit()
  }

  /** The tab went behind another; it gives its WebGL context up. */
  hide(): void {
    this.visible = false
    this.detachWebgl()
  }

  /** Matches the PTY size to the window size. Reports real changes only. */
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
      // proposeDimensions can fail while the layout is being rearranged.
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

  setAppearance(appearance: Appearance): void {
    this.term.options.theme = THEMES[appearance]
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
