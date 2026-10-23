import type { TranscriptImage } from '@shared/types'
import { icon } from './icons'

export interface ImagePanelHandlers {
  /** A thumbnail was clicked: show `images[index]` large. */
  open(images: TranscriptImage[], index: number): void
  /** The panel changed width, so the terminal beside it has to refit. */
  resized(): void
}

/** How many entries keep a full thumbnail; everything older becomes a faded tile. */
const RECENT = 3

/** Long enough to follow a thumbnail shrinking into the grid, short enough not to wait for. */
const GLIDE_MS = 220

/**
 * The images a tab's conversation has seen, as a strip beside the terminal — newest at
 * the bottom, the way the conversation runs.
 *
 * A long session reads a lot of images, so the strip ages them: the last `RECENT`
 * entries are thumbnails with a name, everything before that shrinks into a grid of
 * small faded tiles that come back on hover. And a file read again is one entry, not
 * another thumbnail — a screenshot taken to the same path over and over is the common
 * case — showing its newest version with a count; every version stays in the viewer,
 * since the transcript kept each one.
 *
 * It only exists once there is an image, and it can be closed away entirely: a new
 * image brings it back, and so does `toggle` (Ctrl+Shift+I). What a tab finds in its
 * history when it starts does not, because a restore is not news. Clicks never take
 * the keyboard from the terminal.
 */
export class ImagePanel {
  readonly el: HTMLDivElement
  private readonly count: HTMLSpanElement
  private readonly list: HTMLDivElement
  /** Every image in the order it arrived — what the viewer steps through. */
  private images: TranscriptImage[] = []
  /** Entry key → its versions, oldest first. */
  private entries = new Map<string, TranscriptImage[]>()
  /** Entry keys, the one seen most recently last. */
  private order: string[] = []
  /** Whether it is on screen; it can only be while there are images. */
  private shown = false

  constructor(private readonly handlers: ImagePanelHandlers) {
    this.el = document.createElement('div')
    this.el.className = 'image-panel'
    // The terminal keeps the keyboard; a click only runs what it hit.
    this.el.addEventListener('mousedown', (ev) => ev.preventDefault())

    const head = document.createElement('div')
    head.className = 'image-panel-head'
    this.count = document.createElement('span')
    this.count.className = 'image-panel-count'
    const label = document.createElement('span')
    label.className = 'image-panel-label'
    label.textContent = 'Images'
    const close = document.createElement('button')
    close.className = 'image-panel-close'
    close.title = 'Close (Ctrl+Shift+I brings it back)'
    close.appendChild(icon('close'))
    close.addEventListener('click', () => this.setShown(false))
    head.append(icon('image'), label, this.count, close)

    this.list = document.createElement('div')
    this.list.className = 'image-panel-list'

    this.el.append(head, this.list)
  }

  /** `reset` replaces everything: the tab follows another conversation now. */
  add(images: TranscriptImage[], reset: boolean): void {
    if (reset) {
      this.images = []
      this.entries.clear()
      this.order = []
    }
    for (const image of images) {
      this.images.push(image)
      const key = entryKey(image)
      const versions = this.entries.get(key)
      if (versions) {
        versions.push(image)
        this.order.splice(this.order.indexOf(key), 1)
      } else {
        this.entries.set(key, [image])
      }
      this.order.push(key)
    }

    this.count.textContent = String(this.order.length)
    this.el.title = `${this.images.length} image${this.images.length === 1 ? '' : 's'} in this conversation`

    const news = !reset && images.length > 0
    this.render(news && this.shown)
    this.setShown(news || (this.shown && this.images.length > 0))
  }

  /** Closes it, or brings it back. false when there is nothing to show. */
  toggle(): boolean {
    if (this.images.length === 0) return false
    this.setShown(!this.shown)
    return true
  }

  /** Rebuilds the list; with `glide`, what moved is seen moving there. */
  private render(glide: boolean): void {
    const before = glide ? this.positions() : undefined

    const older = this.order.slice(0, -RECENT)
    const recent = this.order.slice(-RECENT)
    const children: HTMLElement[] = []
    if (older.length > 0) {
      const grid = document.createElement('div')
      grid.className = 'image-grid'
      grid.append(...older.map((key) => this.item(key, 'image-tile')))
      children.push(grid)
    }
    children.push(...recent.map((key) => this.item(key, 'image-thumb')))
    this.list.replaceChildren(...children)
    this.list.scrollTop = this.list.scrollHeight

    if (before) this.glide(before)
  }

  private item(key: string, className: string): HTMLElement {
    const versions = this.entries.get(key) ?? []
    const image = versions[versions.length - 1]
    const item = document.createElement('button')
    item.className = className
    item.dataset['key'] = key
    item.title = versions.length > 1 ? `${image.label} (${versions.length} versions)` : image.label

    const frame = document.createElement('span')
    frame.className = 'image-frame'
    const img = document.createElement('img')
    img.src = image.url
    img.alt = ''
    frame.appendChild(img)
    if (versions.length > 1) {
      const badge = document.createElement('span')
      badge.className = 'image-versions'
      badge.textContent = `×${versions.length}`
      frame.appendChild(badge)
    }
    item.appendChild(frame)

    if (className === 'image-thumb') {
      const caption = document.createElement('span')
      caption.className = 'image-thumb-caption'
      caption.textContent = shortLabel(image.label)
      item.appendChild(caption)
    }
    item.addEventListener('click', () => this.handlers.open(this.images, this.images.indexOf(image)))
    return item
  }

  private positions(): Map<string, DOMRect> {
    const rects = new Map<string, DOMRect>()
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-key]')) {
      rects.set(el.dataset['key'] ?? '', el.getBoundingClientRect())
    }
    return rects
  }

  /**
   * FLIP, as the tab bar does it: each entry starts where it was drawn before and
   * scales into its new place, so a thumbnail visibly shrinks into the grid when a
   * newer one pushes it out; what is new fades in.
   */
  private glide(before: Map<string, DOMRect>): void {
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-key]')) {
      const from = before.get(el.dataset['key'] ?? '')
      if (!from) {
        el.animate([{ opacity: 0 }, {}], { duration: GLIDE_MS, easing: 'ease-out' })
        continue
      }
      const to = el.getBoundingClientRect()
      if (to.width === 0 || to.height === 0) continue
      const dx = from.left - to.left
      const dy = from.top - to.top
      const sx = from.width / to.width
      const sy = from.height / to.height
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) continue
      el.animate(
        [{ transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, {}],
        { duration: GLIDE_MS, easing: 'ease-out' }
      )
    }
  }

  private setShown(shown: boolean): void {
    if (this.shown === shown) return
    this.shown = shown
    this.el.classList.toggle('visible', shown)
    this.handlers.resized()
    if (shown) this.list.scrollTop = this.list.scrollHeight
  }
}

/**
 * What makes two images one entry: the file they were read from. Anything without a
 * path — a pasted image, a tool's screenshot — stands on its own.
 */
function entryKey(image: TranscriptImage): string {
  return /[\\/]/.test(image.label) ? `file:${image.label.replace(/\//g, '\\').toLowerCase()}` : `id:${image.id}`
}

/** A file path by its name, anything else as it is. */
export function shortLabel(label: string): string {
  return /[\\/]/.test(label) ? label.split(/[\\/]/).pop() || label : label
}
