import type { TranscriptImage } from '@shared/types'
import { icon } from './icons'
import { shortLabel } from './ImagePanel'

/**
 * One image at the size of the window, over everything. Left and Right step through
 * the tab's images, Esc and a click beside the image close it; a file the image was
 * read from can be handed to the default viewer.
 */
export class ImageViewer {
  private readonly root: HTMLDivElement
  private readonly img: HTMLImageElement
  private readonly caption: HTMLSpanElement
  private readonly position: HTMLSpanElement
  private readonly openButton: HTMLButtonElement
  private images: TranscriptImage[] = []
  private index = 0
  private open = false

  /** `onClosed` runs once the overlay is gone, so the caller can take the focus back. */
  constructor(
    private readonly openFile: (imageId: string) => Promise<boolean>,
    private readonly onClosed: () => void
  ) {
    this.root = document.createElement('div')
    this.root.className = 'image-viewer'
    this.root.tabIndex = -1

    this.img = document.createElement('img')
    this.img.className = 'image-viewer-img'
    this.img.alt = ''

    const bar = document.createElement('div')
    bar.className = 'image-viewer-bar'
    this.caption = document.createElement('span')
    this.caption.className = 'image-viewer-caption'
    this.position = document.createElement('span')
    this.position.className = 'image-viewer-position'
    this.openButton = document.createElement('button')
    this.openButton.textContent = 'Open file'
    this.openButton.addEventListener('click', () => {
      const image = this.images[this.index]
      if (image) void this.openFile(image.id)
    })
    const close = document.createElement('button')
    close.className = 'image-viewer-close'
    close.title = 'Close (Esc)'
    close.appendChild(icon('close'))
    close.addEventListener('click', () => this.close())
    bar.append(this.caption, this.position, this.openButton, close)

    this.root.append(this.img, bar)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.close()
    })
    // Every key is the viewer's while it is open, wherever the focus happens to be.
    // A listener on the overlay alone missed them whenever the focus was elsewhere —
    // on <body> after a click on the image, or back in a terminal something else
    // focused — and Esc then reached the terminal behind and interrupted Claude.
    // Capture on window runs ahead of the keymap's listener on document.
    const swallow = (ev: KeyboardEvent): void => {
      if (!this.open) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      if (ev.type !== 'keydown') return
      if (ev.key === 'Escape') this.close()
      else if (ev.key === 'ArrowLeft') this.show(this.index - 1)
      else if (ev.key === 'ArrowRight') this.show(this.index + 1)
    }
    window.addEventListener('keydown', swallow, true)
    window.addEventListener('keypress', swallow, true)
    window.addEventListener('keyup', swallow, true)
    // And the focus stays on the overlay, so nothing behind it starts out with the keyboard
    // once the viewer closes. A button in its bar may hold it.
    document.addEventListener('focusin', (ev) => {
      if (this.open && !(ev.target instanceof Node && this.root.contains(ev.target))) this.root.focus()
    })
  }

  isOpen(): boolean {
    return this.open
  }

  /** The list is the tab's own, so stepping on reaches every image it has. */
  view(images: TranscriptImage[], index: number): void {
    this.images = images
    this.open = true
    this.root.classList.add('visible')
    this.show(index)
    this.root.focus()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.root.classList.remove('visible')
    this.img.removeAttribute('src')
    this.onClosed()
  }

  private show(index: number): void {
    if (index < 0 || index >= this.images.length) return
    this.index = index
    const image = this.images[index]
    this.img.src = image.url
    this.caption.textContent = shortLabel(image.label)
    this.caption.title = image.label
    this.position.textContent =
      `${index + 1} / ${this.images.length}` + (image.width ? ` · ${image.width}×${image.height}` : '')
    this.openButton.hidden = !image.hasFile
  }
}
