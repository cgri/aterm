export interface ConfirmRequest {
  message: string
  /** Label of the button that resolves to true. */
  confirmLabel: string
  cancelLabel?: string
}

/**
 * Modal yes/no overlay, in the same shape as the session picker — `confirm()`
 * draws a native Chromium dialog that looks nothing like the rest of the app.
 *
 * Like the other overlays it takes the focus while it is open, so the keymap lets
 * plain keys through to it. Enter confirms (the confirming button has the focus),
 * Escape and a click on the backdrop cancel.
 */
export class ConfirmDialog {
  private readonly root: HTMLDivElement
  private readonly box: HTMLDivElement
  private readonly text: HTMLDivElement
  private readonly actions: HTMLDivElement
  private resolve?: (answer: boolean) => void

  /** Called after the overlay is gone, so the caller can take the focus back. */
  constructor(private readonly onClosed: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'picker'

    this.box = document.createElement('div')
    this.box.className = 'picker-box dialog-box'

    this.text = document.createElement('div')
    this.text.className = 'dialog-text'

    this.actions = document.createElement('div')
    this.actions.className = 'dialog-actions'

    this.box.append(this.text, this.actions)
    this.root.appendChild(this.box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.answer(false)
    })
    this.box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      this.answer(false)
    })
  }

  isOpen(): boolean {
    return Boolean(this.resolve)
  }

  /** Resolves to false right away when a dialog is already open — they never stack. */
  ask(request: ConfirmRequest): Promise<boolean> {
    if (this.isOpen()) return Promise.resolve(false)

    this.text.textContent = request.message
    this.actions.replaceChildren(
      this.button(request.cancelLabel ?? 'Cancel', false),
      this.button(request.confirmLabel, true)
    )
    this.root.classList.add('visible')

    return new Promise<boolean>((resolve) => {
      this.resolve = resolve
      // The confirming button is the default: the user asked for this action.
      ;(this.actions.lastElementChild as HTMLButtonElement).focus()
    })
  }

  private button(label: string, confirming: boolean): HTMLButtonElement {
    const el = document.createElement('button')
    el.textContent = label
    if (confirming) el.className = 'primary'
    el.addEventListener('click', () => this.answer(confirming))
    return el
  }

  private answer(value: boolean): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = undefined
    this.root.classList.remove('visible')
    resolve(value)
    this.onClosed()
  }
}
