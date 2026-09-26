import type { UpdateCheck } from '@shared/types'
import { UpdateDialog, type UpdatePhase } from './UpdateDialog'
import { icon } from './icons'

/**
 * GitHub allows 60 unauthenticated requests an hour per IP address, and a check is one
 * request, so an hourly check leaves room for several aterm windows behind one address.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface UpdatesOptions {
  /** Installing quits aterm, which ends every running tab — the caller knows which. */
  confirmInstall: (version: string) => Promise<boolean>
  /** Called after the dialog is gone, so the caller can take the focus back. */
  onClosed: () => void
}

/**
 * Looks for newer releases, and owns the tab-bar button and the dialog that come with
 * one. The button stays hidden until a check finds something; a check that could not
 * reach GitHub changes nothing, so a flaky connection does not make it come and go.
 */
export class Updates {
  readonly button: HTMLButtonElement
  private readonly dialog: UpdateDialog
  private check?: UpdateCheck
  private phase: UpdatePhase = { kind: 'available' }

  constructor(private readonly options: UpdatesOptions) {
    this.button = document.createElement('button')
    this.button.id = 'update-button'
    this.button.appendChild(icon('update'))
    this.button.hidden = true
    this.button.addEventListener('click', () => this.openDialog())

    this.dialog = new UpdateDialog(() => void this.act(), options.onClosed)

    window.aterm.update.onProgress(({ received, total }) => {
      if (this.phase.kind !== 'downloading' || !total) return
      const percent = Math.min(100, Math.floor((received / total) * 100))
      if (percent !== this.phase.percent) this.setPhase({ kind: 'downloading', percent })
    })
  }

  start(): void {
    void this.refresh()
    window.setInterval(() => void this.refresh(), CHECK_INTERVAL_MS)
  }

  isOpen(): boolean {
    return this.dialog.isOpen()
  }

  private async refresh(): Promise<void> {
    // Once a download has started, the version it is for is the one on offer.
    if (this.phase.kind === 'downloading' || this.phase.kind === 'ready') return
    const check = await window.aterm.update.check()
    if (!check) return
    this.check = check.releases.length > 0 ? check : undefined
    this.setPhase({ kind: 'available' })
  }

  private openDialog(): void {
    if (this.check) this.dialog.show(this.check, this.phase)
  }

  /** The dialog's primary button. */
  private async act(): Promise<void> {
    const check = this.check
    if (!check) return
    const newest = check.releases[0]

    if (check.mode !== 'installer') {
      // Handed to the browser by the main process's window-open handler.
      window.open(newest.url)
      return
    }

    if (this.phase.kind === 'available' || this.phase.kind === 'failed') {
      this.setPhase({ kind: 'downloading', percent: 0 })
      const result = await window.aterm.update.download()
      this.setPhase(result.ok ? { kind: 'ready' } : { kind: 'failed', error: result.error ?? 'Download failed.' })
      return
    }

    if (this.phase.kind === 'ready') {
      this.dialog.close()
      if (!(await this.options.confirmInstall(newest.version))) return
      const result = await window.aterm.update.install()
      // On success aterm is quitting; there is nothing left to show.
      if (result.ok) return
      this.setPhase({ kind: 'failed', error: result.error ?? 'The installer did not start.' })
      this.openDialog()
    }
  }

  private setPhase(phase: UpdatePhase): void {
    this.phase = phase
    this.dialog.setPhase(phase)

    const check = this.check
    this.button.hidden = !check
    if (!check) return
    const version = check.releases[0].version
    this.button.dataset.state = phase.kind
    this.button.title =
      phase.kind === 'downloading'
        ? `Downloading aterm ${version}… ${phase.percent}%`
        : phase.kind === 'ready'
          ? `aterm ${version} is ready to install`
          : phase.kind === 'failed'
            ? `Updating to aterm ${version} failed — click for details`
            : `aterm ${version} is available — click to see what's new`
  }
}
