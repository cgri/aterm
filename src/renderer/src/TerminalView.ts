import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Appearance } from '@shared/types'
import { icon } from './icons'

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

/** How long after a mouseup the selection it ended may still be offered. */
const SELECTION_REPORT_MS = 1000

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
  private appearance: Appearance
  // The program asked to hear about theme changes (DEC mode 2031).
  private themeReports = false
  // Offered beside a selection the mouse just made: quote it into the prompt.
  private readonly quoteChip: HTMLButtonElement
  // What a program in mouse-tracking mode reported as selected (OSC 52), while the
  // chip offers it.
  private programSelection?: string
  private lastMouseUp?: { x: number; y: number; at: number }
  // The last OSC 52 since the mouse went down.
  private reported?: string

  constructor(
    readonly tabId: string,
    fontSize: number,
    appearance: Appearance,
    private readonly onInput: (data: string) => void,
    private readonly onResize: (cols: number, rows: number) => void,
    private readonly onTitle: (title: string) => void,
    private readonly onQuote: (text: string) => void
  ) {
    this.appearance = appearance
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

    this.handleThemeReports()

    this.quoteChip = this.makeQuoteChip()
    this.handleClipboardWrites()
  }

  /**
   * The chip is a sibling of xterm's own element, not inside it, so pressing it never
   * reaches xterm's selection handling — which would clear the selection on mousedown
   * before the click could read it. A click on the selection itself is not the
   * trigger: that is how a selection is dismissed, and a drag from inside it starts a
   * new one.
   */
  private makeQuoteChip(): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.className = 'quote-chip'
    chip.tabIndex = -1
    chip.title = 'Quote the selection into the prompt (Ctrl+Shift+Q)'
    chip.append(icon('comment'), 'Comment')
    // Keeps the focus on the terminal and the selection where it is.
    chip.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    })
    chip.addEventListener('click', () => this.quote())
    this.element.appendChild(chip)

    // Deferred, so a selection xterm finishes on its own mouseup is complete.
    this.element.addEventListener('mouseup', (ev) => {
      if (ev.button !== 0 || chip.contains(ev.target as Node)) return
      this.lastMouseUp = { x: ev.clientX, y: ev.clientY, at: Date.now() }
      setTimeout(() => {
        if (this.term.hasSelection()) this.showQuoteChip(ev.clientX, ev.clientY)
        else if (this.reported) this.offerProgramSelection(this.reported)
      })
    })
    this.element.addEventListener('mousedown', (ev) => {
      if (chip.contains(ev.target as Node)) return
      this.hideQuoteChip()
      this.reported = undefined
      this.lastMouseUp = undefined
    })
    this.element.addEventListener('wheel', () => this.hideQuoteChip(), { passive: true })
    this.term.onSelectionChange(() => {
      if (!this.term.hasSelection() && this.programSelection === undefined) this.hideQuoteChip()
    })
    // New output moves the selection with the buffer, away from where the chip sits.
    this.term.onScroll(() => this.hideQuoteChip())
    this.term.onKey(() => this.hideQuoteChip())
    return chip
  }

  /**
   * OSC 52, a program writing to the clipboard. Claude Code's fullscreen mode turns
   * mouse tracking on, so a drag goes to Claude Code rather than to xterm.js: it draws
   * the selection itself and sends the text here when the button is released. xterm.js
   * knows no OSC 52, so it is the clipboard write — and, when it follows a mouseup in
   * this terminal, the selection the chip quotes. A query (`?`) is never answered:
   * the clipboard is not the program's to read.
   */
  private handleClipboardWrites(): void {
    this.term.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1)
      if (!payload || payload === '?') return true
      let text: string
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
      } catch {
        return true
      }
      void window.aterm.system.writeClipboard(text)
      // Claude Code sends it while the drag is still on as well as after it; whichever
      // comes last, mouseup or report, offers it.
      this.reported = text
      if (this.lastMouseUp) this.offerProgramSelection(text)
      return true
    })
  }

  /** Only the report of a drag that just ended in this terminal, never a stray one. */
  private offerProgramSelection(text: string): void {
    const up = this.lastMouseUp
    if (!up || Date.now() - up.at > SELECTION_REPORT_MS || this.term.hasSelection()) return
    this.programSelection = text
    this.showQuoteChip(up.x, up.y)
  }

  private showQuoteChip(clientX: number, clientY: number): void {
    const chip = this.quoteChip
    const box = this.element.getBoundingClientRect()
    chip.classList.add('visible')
    const { offsetWidth: w, offsetHeight: h } = chip
    let x = clientX - box.left + 8
    let y = clientY - box.top + 14
    if (x + w > box.width - 4) x = Math.max(4, clientX - box.left - w - 8)
    if (y + h > box.height - 4) y = Math.max(4, clientY - box.top - h - 14)
    chip.style.left = `${x}px`
    chip.style.top = `${y}px`
  }

  private hideQuoteChip(): void {
    this.quoteChip.classList.remove('visible')
    this.programSelection = undefined
  }

  /**
   * The selection as one line — xterm's own, or the one the program reported. Claude
   * Code wraps its output itself, so a line break in it is layout rather than content,
   * and one typed into the prompt would submit it.
   */
  quotableSelection(): string | undefined {
    const raw = this.term.hasSelection() ? this.term.getSelection() : (this.programSelection ?? '')
    const text = raw.replace(/\s*\n\s*/g, ' ').trim()
    return text || undefined
  }

  /** What the cursor's line holds in front of the cursor. */
  textBeforeCursor(): string {
    const buffer = this.term.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    return line?.translateToString(true, 0, buffer.cursorX) ?? ''
  }

  /** Hands the selection to `onQuote` and lets go of it. false without one. */
  quote(): boolean {
    const text = this.quotableSelection()
    this.hideQuoteChip()
    if (!text) return false
    this.term.clearSelection()
    this.onQuote(text)
    this.focus()
    return true
  }

  /**
   * DEC mode 2031, which xterm.js does not know: a program that sets it is told
   * whenever the terminal switches between dark and light (`CSI ? 997 ; 1 n` dark,
   * `; 2 n` light), and `CSI ? 996 n` asks for the current one. Claude Code's
   * "auto" theme sets it and answers each report by asking OSC 11 for the
   * background again, which xterm.js answers from the theme by itself.
   */
  private handleThemeReports(): void {
    const setMode = (on: boolean) => (params: (number | number[])[]) => {
      if (params.includes(2031)) this.themeReports = on
      // Other modes in the same sequence are still xterm.js's to handle.
      return false
    }
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, setMode(true))
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, setMode(false))
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params.length !== 1 || params[0] !== 996) return false
      this.reportTheme()
      return true
    })
  }

  private reportTheme(): void {
    this.onInput(`[?997;${this.appearance === 'dark' ? 1 : 2}n`)
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
    this.hideQuoteChip()
    this.detachWebgl()
  }

  /** Matches the PTY size to the window size. Reports real changes only. */
  refit(): void {
    if (!this.element.isConnected || this.element.clientHeight === 0) return
    this.hideQuoteChip()
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
    if (appearance === this.appearance) return
    this.appearance = appearance
    this.term.options.theme = THEMES[appearance]
    if (this.themeReports) this.reportTheme()
  }

  /** Back to a blank terminal for the next process. */
  reset(): void {
    this.term.reset()
    this.themeReports = false
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
