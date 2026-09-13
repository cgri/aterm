import type { UpdateCheck } from '@shared/types'
import { renderReleaseNotes } from './releaseNotes'

/** Where an update stands, as far as the renderer is concerned. */
export type UpdatePhase =
  | { kind: 'available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' }
  | { kind: 'failed'; error: string }

/**
 * The release notes of every version newer than the running one, and the one action
 * that fits: download, then install for the NSIS install; the release page for the
 * portable exe and a dev run, which cannot replace themselves.
 *
 * The same overlay as the other dialogs, and like them it keeps the focus while it is
 * open. Escape and a click on the backdrop close it. Closing it does not stop a
 * download; the tab-bar button keeps showing that.
 */
export class UpdateDialog {
  private readonly root: HTMLDivElement
  private readonly box: HTMLDivElement
  private readonly heading: HTMLDivElement
  private readonly subheading: HTMLDivElement
  private readonly notes: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly primary: HTMLButtonElement
  private check?: UpdateCheck
  private open = false

  constructor(
    private readonly onPrimary: () => void,
    /** Called after the overlay is gone, so the caller can take the focus back. */
    private readonly onClosed: () => void
  ) {
    this.root = document.createElement('div')
    this.root.className = 'picker'

    this.box = document.createElement('div')
    this.box.className = 'picker-box dialog-box update-box'
    // Focusable itself, so the focus has somewhere to stay while the button is disabled.
    this.box.tabIndex = -1

    const head = document.createElement('div')
    head.className = 'update-head'
    this.heading = document.createElement('div')
    this.heading.className = 'update-heading'
    this.subheading = document.createElement('div')
    this.subheading.className = 'update-subheading'
    head.append(this.heading, this.subheading)

    this.notes = document.createElement('div')
    this.notes.className = 'update-notes'

    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    this.status = document.createElement('div')
    this.status.className = 'update-status'
    const later = document.createElement('button')
    later.textContent = 'Later'
    later.addEventListener('click', () => this.close())
    this.primary = document.createElement('button')
    this.primary.className = 'primary'
    this.primary.addEventListener('click', () => this.onPrimary())
    actions.append(this.status, later, this.primary)

    this.box.append(head, this.notes, actions)
    this.root.appendChild(this.box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.close()
    })
    this.box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      this.close()
    })
  }

  isOpen(): boolean {
    return this.open
  }

  show(check: UpdateCheck, phase: UpdatePhase): void {
    this.check = check
    const newest = check.releases[0]
    this.heading.textContent = `aterm ${newest.version} is available`
    this.subheading.textContent =
      check.releases.length === 1
        ? `You have ${check.current}.`
        : `You have ${check.current}. ${check.releases.length} releases since then:`

    this.notes.replaceChildren(
      ...check.releases.map((release) => {
        const section = document.createElement('section')
        const title = document.createElement('h3')
        title.textContent = release.title
        const date = document.createElement('span')
        date.className = 'update-date'
        date.textContent = release.publishedAt.slice(0, 10)
        title.appendChild(date)
        section.append(title, renderReleaseNotes(release.notes))
        return section
      })
    )
    this.notes.scrollTop = 0

    this.setPhase(phase)
    this.open = true
    this.root.classList.add('visible')
    if (this.primary.disabled) this.box.focus()
    else this.primary.focus()
  }

  setPhase(phase: UpdatePhase): void {
    const check = this.check
    if (!check) return
    const hadFocus = this.box.contains(document.activeElement)

    this.status.classList.toggle('error', phase.kind === 'failed')
    this.primary.disabled = false

    if (check.mode !== 'installer') {
      this.status.textContent =
        check.mode === 'portable'
          ? 'The portable version does not update itself.'
          : 'A development build does not update itself.'
      this.primary.textContent = 'Open release page'
    } else if (phase.kind === 'downloading') {
      this.status.textContent = ''
      this.primary.textContent = `Downloading… ${phase.percent}%`
      this.primary.disabled = true
    } else if (phase.kind === 'ready') {
      this.status.textContent = 'Downloaded and verified.'
      this.primary.textContent = 'Restart and install'
    } else if (phase.kind === 'failed') {
      this.status.textContent = phase.error
      this.primary.textContent = 'Try again'
    } else {
      this.status.textContent = ''
      this.primary.textContent = 'Download and install'
    }

    if (!this.open || !hadFocus) return
    if (this.primary.disabled) this.box.focus()
    else this.primary.focus()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.root.classList.remove('visible')
    this.onClosed()
  }
}
