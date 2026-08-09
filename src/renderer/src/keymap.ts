import type { TabKind } from '@shared/types'
import type { TerminalView } from './TerminalView'

export interface KeymapContext {
  activeView(): TerminalView | undefined
  /** Writes straight into the active tab's PTY. */
  write(data: string): void
  newTab(kind: TabKind): void
  /** The overlay behind "+". */
  openNewTabMenu(): void
  closeActiveTab(): void
  cycleTab(delta: number): void
  selectTabByIndex(index: number): void
  openSessionPicker(): void
  toggleSearch(): void
  changeFontSize(delta: number | 'reset'): void
  /** Enter on a tab that has not started → start it. true when it did. */
  startActiveTab(): boolean
  overlayOpen(): boolean
}

/** Everything that can be rebound through userData/keymap.json. */
export type Action =
  | 'newTabMenu'
  | 'newClaudeTab'
  | 'newShellTab'
  | 'closeTab'
  | 'nextTab'
  | 'previousTab'
  | 'sessionPicker'
  | 'search'
  | 'paste'
  | 'copy'
  | 'pasteImage'
  | 'newline'
  | 'fontLarger'
  | 'fontSmaller'
  | 'fontReset'

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  newTabMenu: ['Ctrl+T'],
  // No default: Ctrl+T opens the menu instead. Still bindable in keymap.json.
  newClaudeTab: [],
  newShellTab: ['Ctrl+Shift+T'],
  closeTab: ['Ctrl+W'],
  nextTab: ['Ctrl+Tab', 'Ctrl+PageDown'],
  previousTab: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  sessionPicker: ['Ctrl+Shift+O'],
  search: ['Ctrl+Shift+F'],
  paste: ['Ctrl+V', 'Ctrl+Shift+V'],
  copy: ['Ctrl+Shift+C'],
  // ESC v — this triggers Claude Code's own image paste.
  pasteImage: ['Alt+V'],
  // ESC CR — newline in the prompt instead of submitting.
  newline: ['Shift+Enter'],
  fontLarger: ['Ctrl++', 'Ctrl+='],
  fontSmaller: ['Ctrl+-'],
  fontReset: ['Ctrl+0']
}

interface Combo {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

/** "Ctrl+Shift+O" → Combo. Unrecognised entries are skipped. */
export function parseCombo(text: string): Combo | undefined {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return undefined

  const combo: Combo = { ctrl: false, shift: false, alt: false, key: '' }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') combo.ctrl = true
    else if (lower === 'shift') combo.shift = true
    else if (lower === 'alt') combo.alt = true
    else combo.key = lower
  }
  // "Ctrl++" splits into ['Ctrl','',''] — the trailing entry is then the key.
  if (!combo.key && text.endsWith('+')) combo.key = '+'
  return combo.key ? combo : undefined
}

function matches(ev: KeyboardEvent, combo: Combo): boolean {
  return (
    ev.ctrlKey === combo.ctrl &&
    ev.shiftKey === combo.shift &&
    ev.altKey === combo.alt &&
    ev.key.toLowerCase() === combo.key
  )
}

export type Bindings = Array<{ action: Action; combo: Combo }>

/**
 * Builds the bindings from the defaults and the overrides in keymap.json. An
 * override replaces an action's default entirely; an empty array disables it.
 */
export function buildBindings(overrides?: Partial<Record<Action, string[]>>): Bindings {
  const bindings: Bindings = []
  for (const action of Object.keys(DEFAULT_BINDINGS) as Action[]) {
    const source = overrides?.[action] ?? DEFAULT_BINDINGS[action]
    for (const text of source) {
      const combo = parseCombo(text)
      if (combo) bindings.push({ action, combo })
    }
  }
  return bindings
}

/**
 * A single listener in the capture phase: whatever is handled here never reaches
 * xterm.js. Everything else goes through to the PTY untouched.
 */
export function installKeymap(ctx: KeymapContext, bindings: Bindings): void {
  document.addEventListener(
    'keydown',
    (ev) => {
      if (handle(ev, ctx, bindings)) {
        ev.preventDefault()
        ev.stopPropagation()
      }
    },
    true
  )
}

/** One wheel notch on Windows is 100; precision trackpads send far smaller steps. */
const ZOOM_STEP = 100

/**
 * Ctrl+Wheel changes the font size. Registered with `passive: false`, because
 * Chromium makes wheel listeners on `document` passive by default and then
 * ignores `preventDefault()` — without it the page zooms on top of the resize.
 */
export function installWheelZoom(changeFontSize: (delta: number) => void): void {
  let accumulated = 0

  document.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey || ev.altKey) return
      ev.preventDefault()
      ev.stopPropagation()

      accumulated += ev.deltaY
      while (Math.abs(accumulated) >= ZOOM_STEP) {
        const direction = Math.sign(accumulated)
        accumulated -= direction * ZOOM_STEP
        // Wheel up means a negative deltaY, and up should enlarge.
        changeFontSize(-direction)
      }
    },
    { capture: true, passive: false }
  )
}

function handle(ev: KeyboardEvent, ctx: KeymapContext, bindings: Bindings): boolean {
  // Overlays (session picker, search) bring their own keyboard handling; only
  // combinations with Ctrl or Alt still get through there.
  if (ctx.overlayOpen() && !ev.ctrlKey && !ev.altKey) return false

  const hit = bindings.find((b) => matches(ev, b.combo))
  if (hit) return dispatch(hit.action, ctx, ev)

  // Ctrl+C is context dependent: copy with a selection, interrupt without one
  // (0x03 to the PTY) — exactly as PowerShell behaves.
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') {
    if (ctx.activeView()?.term.hasSelection()) {
      void copySelection(ctx)
      return true
    }
    return false
  }

  // Ctrl+1..9 jumps straight to a tab.
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(ev.key)) {
    ctx.selectTabByIndex(Number(ev.key) - 1)
    return true
  }

  // Enter starts a placeholder tab — only when no process is running in it.
  if (!ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.key === 'Enter') {
    return ctx.startActiveTab()
  }

  return false
}

function dispatch(action: Action, ctx: KeymapContext, ev: KeyboardEvent): boolean {
  switch (action) {
    case 'newTabMenu':
      ctx.openNewTabMenu()
      return true
    case 'newClaudeTab':
      ctx.newTab('claude')
      return true
    case 'newShellTab':
      ctx.newTab('powershell')
      return true
    case 'closeTab':
      ctx.closeActiveTab()
      return true
    case 'nextTab':
      ctx.cycleTab(1)
      return true
    case 'previousTab':
      ctx.cycleTab(-1)
      return true
    case 'sessionPicker':
      ctx.openSessionPicker()
      return true
    case 'search':
      ctx.toggleSearch()
      return true
    case 'paste':
      void paste(ctx)
      return true
    case 'copy':
      void copySelection(ctx)
      return true
    case 'pasteImage':
      ctx.write('\x1bv')
      return true
    case 'newline':
      ctx.write('\x1b\r')
      return true
    case 'fontLarger':
      ctx.changeFontSize(1)
      return true
    case 'fontSmaller':
      ctx.changeFontSize(-1)
      return true
    case 'fontReset':
      ctx.changeFontSize('reset')
      return true
    default: {
      // Should be unreachable — rather pass the key on than swallow it.
      void ev
      return false
    }
  }
}

async function copySelection(ctx: KeymapContext): Promise<void> {
  const text = ctx.activeView()?.term.getSelection()
  if (text) await window.aterm.system.writeClipboard(text)
}

async function paste(ctx: KeymapContext): Promise<void> {
  const view = ctx.activeView()
  if (!view) return
  const payload = await window.aterm.system.readClipboard()
  if (payload.kind === 'text') view.term.paste(payload.text)
  // Images land as a file in the temp directory; Claude Code reads the path.
  else if (payload.kind === 'image') view.term.paste(`"${payload.path}"`)
}
