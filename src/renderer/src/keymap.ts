import type { TabKind } from '@shared/types'
import type { TerminalView } from './TerminalView'

export interface KeymapContext {
  activeView(): TerminalView | undefined
  /** Schreibt direkt ins PTY des aktiven Tabs. */
  write(data: string): void
  newTab(kind: TabKind): void
  closeActiveTab(): void
  cycleTab(delta: number): void
  selectTabByIndex(index: number): void
  openSessionPicker(): void
  toggleSearch(): void
  changeFontSize(delta: number | 'reset'): void
  /** Enter auf einem noch nicht gestarteten Tab → starten. true, wenn gestartet. */
  startActiveTab(): boolean
  overlayOpen(): boolean
}

/** Alles, was sich über userData/keymap.json umbelegen lässt. */
export type Action =
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
  newClaudeTab: ['Ctrl+T'],
  newShellTab: ['Ctrl+Shift+T'],
  closeTab: ['Ctrl+W'],
  nextTab: ['Ctrl+Tab', 'Ctrl+PageDown'],
  previousTab: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  sessionPicker: ['Ctrl+Shift+O'],
  search: ['Ctrl+Shift+F'],
  paste: ['Ctrl+V', 'Ctrl+Shift+V'],
  copy: ['Ctrl+Shift+C'],
  // ESC v — damit greift Claude Codes eigene Bild-Einfügung.
  pasteImage: ['Alt+V'],
  // ESC CR — neue Zeile im Prompt statt Absenden.
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

/** „Ctrl+Shift+O" → Combo. Unbekannte Angaben werden übersprungen. */
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
  // „Ctrl++" zerfällt zu ['Ctrl','',''] — die letzte Angabe ist dann die Taste.
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
 * Baut die Belegung aus den Vorgaben und den Überschreibungen aus keymap.json.
 * Eine Überschreibung ersetzt die Vorgabe einer Aktion vollständig; ein leeres
 * Array schaltet sie ab.
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
 * Ein einziger Listener in der Capture-Phase: Was hier behandelt wird, erreicht
 * xterm.js gar nicht erst. Alles andere läuft unverändert ins PTY.
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

function handle(ev: KeyboardEvent, ctx: KeymapContext, bindings: Bindings): boolean {
  // Overlays (Session-Picker, Suche) bringen ihre eigene Tastatur mit; nur
  // Kombinationen mit Strg oder Alt kommen dort noch durch.
  if (ctx.overlayOpen() && !ev.ctrlKey && !ev.altKey) return false

  const hit = bindings.find((b) => matches(ev, b.combo))
  if (hit) return dispatch(hit.action, ctx, ev)

  // Strg+C ist kontextabhängig: mit Auswahl kopieren, ohne Auswahl abbrechen
  // (0x03 ans PTY) — genau wie in der PowerShell.
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') {
    if (ctx.activeView()?.term.hasSelection()) {
      void copySelection(ctx)
      return true
    }
    return false
  }

  // Ctrl+1..9 springt direkt auf einen Tab.
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(ev.key)) {
    ctx.selectTabByIndex(Number(ev.key) - 1)
    return true
  }

  // Enter startet einen Platzhalter-Tab — nur, wenn dort kein Prozess läuft.
  if (!ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.key === 'Enter') {
    return ctx.startActiveTab()
  }

  return false
}

function dispatch(action: Action, ctx: KeymapContext, ev: KeyboardEvent): boolean {
  switch (action) {
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
      // Sollte unerreichbar sein — lieber durchreichen als schlucken.
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
  // Bilder landen als Datei im Temp-Verzeichnis; Claude Code liest den Pfad.
  else if (payload.kind === 'image') view.term.paste(`"${payload.path}"`)
}
