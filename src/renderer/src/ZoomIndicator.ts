/** How long the badge stays fully visible before it fades out. */
const VISIBLE_MS = 1200

/**
 * Transient zoom level badge ("114%") after a font size change. Every change
 * restarts the timer, so holding Ctrl+Wheel keeps one badge on screen instead of
 * stacking them.
 */
export class ZoomIndicator {
  private readonly el: HTMLDivElement
  private timer?: number

  constructor(host: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'zoom-indicator'
    host.appendChild(this.el)
  }

  show(percent: number): void {
    this.el.textContent = `${percent}%`
    this.el.classList.add('visible')

    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.el.classList.remove('visible')
      this.timer = undefined
    }, VISIBLE_MS)
  }
}
