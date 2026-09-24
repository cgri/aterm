import { TAB_GROUP_COLORS, type TabGroupColor } from '@shared/types'

export interface GroupPromptRequest {
  /** Heading of the dialog — what it is being asked for. */
  title: string
  name?: string
  color: TabGroupColor
  /** Label of the button that answers it. */
  confirmLabel: string
}

export interface GroupPromptResult {
  /** Absent means a group with no name, which is a perfectly good group. */
  name?: string
  color: TabGroupColor
}

/**
 * Asks for a tab group's name and colour, in the same shape as the confirm dialog —
 * `prompt()` draws Chromium's own, which looks nothing like the rest of the app.
 *
 * Answering with nothing (`undefined`) is how a cancel is told apart from a group the
 * user deliberately left nameless; an empty name would read as the second.
 *
 * Like the other overlays it takes the focus while it is open, so the keymap lets plain
 * keys through to it. Escape and a click on the backdrop cancel, Enter in the name field
 * confirms, and the arrow keys walk through the colours.
 */
export class GroupDialog {
  private readonly root: HTMLDivElement
  private readonly box: HTMLDivElement
  private readonly text: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly colors: HTMLDivElement
  private readonly actions: HTMLDivElement
  private resolve?: (answer: GroupPromptResult | undefined) => void
  private color: TabGroupColor = 'grey'

  /** Called after the overlay is gone, so the caller can take the focus back. */
  constructor(private readonly onClosed: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'picker'

    this.box = document.createElement('div')
    this.box.className = 'picker-box dialog-box'

    this.text = document.createElement('div')
    this.text.className = 'dialog-text'

    this.input = document.createElement('input')
    this.input.className = 'group-name'
    this.input.type = 'text'
    this.input.placeholder = 'Name (optional)'
    this.input.spellcheck = false

    this.colors = document.createElement('div')
    this.colors.className = 'group-colors'

    this.actions = document.createElement('div')
    this.actions.className = 'dialog-actions'

    this.box.append(this.text, this.input, this.colors, this.actions)
    this.root.appendChild(this.box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.answer(undefined)
    })
    this.box.addEventListener('keydown', (ev) => this.onKey(ev))
  }

  isOpen(): boolean {
    return Boolean(this.resolve)
  }

  /** Resolves to undefined right away when a dialog is already open — they never stack. */
  ask(request: GroupPromptRequest): Promise<GroupPromptResult | undefined> {
    if (this.isOpen()) return Promise.resolve(undefined)

    this.text.textContent = request.title
    this.input.value = request.name ?? ''
    this.color = request.color
    this.renderColors()
    this.actions.replaceChildren(
      this.button('Cancel', false),
      this.button(request.confirmLabel, true)
    )
    this.root.classList.add('visible')

    return new Promise<GroupPromptResult | undefined>((resolve) => {
      this.resolve = resolve
      // The name field and not the confirming button, unlike ConfirmDialog: there is
      // something to type here, and a colour is already picked.
      this.input.focus()
      this.input.select()
    })
  }

  private renderColors(): void {
    this.colors.replaceChildren(
      ...TAB_GROUP_COLORS.map((color) => {
        const el = document.createElement('button')
        el.type = 'button'
        el.className = `group-color${color === this.color ? ' selected' : ''}`
        el.dataset.groupColor = color
        el.title = color[0].toUpperCase() + color.slice(1)
        el.addEventListener('click', () => this.pick(color))
        return el
      })
    )
  }

  private pick(color: TabGroupColor): void {
    this.color = color
    this.renderColors()
  }

  private step(delta: number): void {
    const at = TAB_GROUP_COLORS.indexOf(this.color)
    const next = (at + delta + TAB_GROUP_COLORS.length) % TAB_GROUP_COLORS.length
    this.pick(TAB_GROUP_COLORS[next])
  }

  private button(label: string, confirming: boolean): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    if (confirming) el.className = 'primary'
    el.addEventListener('click', () => this.answer(confirming ? this.result() : undefined))
    return el
  }

  private result(): GroupPromptResult {
    const name = this.input.value.trim()
    return { name: name ? name : undefined, color: this.color }
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.answer(undefined)
    else if (ev.key === 'Enter') this.answer(this.result())
    else if (ev.key === 'ArrowRight') this.step(1)
    else if (ev.key === 'ArrowLeft') this.step(-1)
    else return

    ev.preventDefault()
    ev.stopPropagation()
  }

  private answer(value: GroupPromptResult | undefined): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = undefined
    this.root.classList.remove('visible')
    resolve(value)
    this.onClosed()
  }
}
