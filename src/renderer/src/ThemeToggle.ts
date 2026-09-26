import type { ThemeMode } from '@shared/types'
import { cycleThemeMode, onThemeChange, themeMode } from './appearance'
import { icon } from './icons'

const LABELS: Record<ThemeMode, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark'
}

/**
 * The tristate theme button at the right end of the tab bar. One button rather
 * than three: it sits between the tabs and the native window controls, where
 * there is only room for a single icon.
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
    this.element.replaceChildren(icon(mode))
    this.element.title = `${LABELS[mode]} — click to switch`
  }
}
