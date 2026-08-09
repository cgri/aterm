import type { ThemeMode } from '@shared/types'
import { cycleThemeMode, onThemeChange, themeMode } from './appearance'

const LABELS: Record<ThemeMode, { glyph: string; title: string }> = {
  system: { glyph: '◐', title: 'Theme: system' },
  light: { glyph: '☀', title: 'Theme: light' },
  dark: { glyph: '☾', title: 'Theme: dark' }
}

/**
 * The tristate theme button at the right end of the tab bar. One button rather
 * than three: it sits between the tabs and the native window controls, where
 * there is only room for a single glyph.
 */
export class ThemeToggle {
  readonly element: HTMLButtonElement

  constructor() {
    this.element = document.createElement('button')
    this.element.id = 'theme-toggle'
    this.element.addEventListener('click', () => cycleThemeMode())
    onThemeChange(() => this.render())
    this.render()
  }

  private render(): void {
    const mode = themeMode()
    this.element.textContent = LABELS[mode].glyph
    this.element.title = `${LABELS[mode].title} — click to switch`
  }
}
