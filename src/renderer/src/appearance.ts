import type { Appearance, ThemeMode } from '@shared/types'

/**
 * The chosen theme mode. It lives in localStorage rather than in state.json,
 * because it has to be readable synchronously: the palette is applied while this
 * module is imported, before the first pixel is drawn. The main process is told
 * the result and remembers it for the next window (see PersistedState.appearance).
 */
const STORAGE_KEY = 'themeMode'

/** The order the toggle cycles through. */
const MODES: ThemeMode[] = ['system', 'light', 'dark']

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

let mode = readMode()
let appearance = resolve(mode)

apply()

// Only relevant while the mode follows the system, but the query stays live so a
// later switch back to 'system' is already up to date.
darkQuery.addEventListener('change', () => {
  if (mode === 'system') apply()
})

export function themeMode(): ThemeMode {
  return mode
}

export function currentAppearance(): Appearance {
  return appearance
}

/** system → light → dark → system. */
export function cycleThemeMode(): void {
  mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
  localStorage.setItem(STORAGE_KEY, mode)
  apply()
}

/** Called after every change of the mode, whether the appearance changed or not. */
export function onThemeChange(listener: () => void): void {
  listeners.add(listener)
}

function readMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  return stored && MODES.includes(stored) ? stored : 'system'
}

function resolve(value: ThemeMode): Appearance {
  if (value !== 'system') return value
  return darkQuery.matches ? 'dark' : 'light'
}

function apply(): void {
  appearance = resolve(mode)
  // The palettes in theme.css hang off this attribute.
  document.documentElement.dataset.theme = appearance
  // Window controls and window background are drawn by Electron, not by CSS.
  window.aterm.system.setAppearance(appearance)
  for (const listener of listeners) listener()
}
