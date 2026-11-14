import { parseSource, titleWithout, type ParsedSource } from './taskSource'

export interface NewTaskRequest {
  /** The folder a session on it would start in; the user may change it. */
  cwd: string
  pickFolder: (startIn: string) => Promise<string | undefined>
}

export interface NewTaskResult {
  title: string
  source?: string
  notes?: string
  cwd: string
  /** Start a Claude session on it right away, rather than leaving it in the backlog. */
  start: boolean
}

/**
 * "New task", from the task list's button or Ctrl+Shift+K anywhere: one field for a title
 * or a pasted link, what was recognised in it, the folder, notes, and whether to leave it
 * in the backlog or start a session on it now. Same shell as the other dialogs, and like
 * them it takes the keyboard while it is open: Enter in the field adds, Esc cancels.
 */
export class TaskDialog {
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly recognised: HTMLDivElement
  private readonly folder: HTMLSpanElement
  private readonly notes: HTMLTextAreaElement
  private readonly backlog: HTMLButtonElement
  private readonly startNow: HTMLButtonElement
  private resolve?: (answer: NewTaskResult | undefined) => void
  private request?: NewTaskRequest
  private cwd = ''
  private start = false
  private parsed?: ParsedSource

  constructor(private readonly onClosed: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'picker'
    const box = document.createElement('div')
    box.className = 'picker-box dialog-box task-dialog'

    const head = document.createElement('div')
    head.className = 'dialog-text task-dialog-head'
    head.textContent = 'New task'

    this.input = document.createElement('input')
    this.input.className = 'task-dialog-input'
    this.input.placeholder = 'What needs doing — or paste a ticket, issue, PR or MR link'
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.recognise())

    this.recognised = document.createElement('div')
    this.recognised.className = 'task-dialog-recognised'

    const folderRow = document.createElement('div')
    folderRow.className = 'task-dialog-row'
    const folderLabel = document.createElement('span')
    folderLabel.className = 'task-dialog-label'
    folderLabel.textContent = 'Folder'
    this.folder = document.createElement('span')
    this.folder.className = 'task-dialog-folder'
    const change = document.createElement('button')
    change.type = 'button'
    change.className = 'task-button quiet'
    change.textContent = 'Change…'
    change.addEventListener('click', () => void this.changeFolder())
    folderRow.append(folderLabel, this.folder, change)

    const thenRow = document.createElement('div')
    thenRow.className = 'task-dialog-row'
    const thenLabel = document.createElement('span')
    thenLabel.className = 'task-dialog-label'
    thenLabel.textContent = 'Then'
    const seg = document.createElement('div')
    seg.className = 'task-segmented'
    seg.setAttribute('role', 'radiogroup')
    this.backlog = this.segment('Keep in backlog', false)
    this.startNow = this.segment('Start a session', true)
    seg.append(this.backlog, this.startNow)
    thenRow.append(thenLabel, seg)

    this.notes = document.createElement('textarea')
    this.notes.className = 'task-notes task-dialog-notes'
    this.notes.rows = 3
    this.notes.placeholder = 'Notes (optional)'

    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => this.answer(undefined))
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'primary'
    add.textContent = 'Add task'
    add.addEventListener('click', () => this.submit())
    actions.append(cancel, add)

    box.append(head, this.input, this.recognised, folderRow, thenRow, this.notes, actions)
    this.root.appendChild(box)
    document.body.appendChild(this.root)

    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.answer(undefined)
    })
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.answer(undefined)
      else if (ev.key === 'Enter' && ev.target === this.input) this.submit()
      else if (ev.key === 'Enter' && ev.ctrlKey) this.submit()
      else return
      ev.preventDefault()
      ev.stopPropagation()
    })
  }

  isOpen(): boolean {
    return Boolean(this.resolve)
  }

  ask(request: NewTaskRequest): Promise<NewTaskResult | undefined> {
    if (this.isOpen()) return Promise.resolve(undefined)
    this.request = request
    this.cwd = request.cwd
    this.folder.textContent = request.cwd
    this.folder.title = request.cwd
    this.input.value = ''
    this.notes.value = ''
    this.setStart(false)
    this.recognise()
    this.root.classList.add('visible')
    return new Promise((resolve) => {
      this.resolve = resolve
      this.input.focus()
    })
  }

  private segment(label: string, start: boolean): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.setAttribute('role', 'radio')
    el.textContent = label
    el.addEventListener('click', () => this.setStart(start))
    return el
  }

  private setStart(start: boolean): void {
    this.start = start
    this.backlog.setAttribute('aria-checked', String(!start))
    this.startNow.setAttribute('aria-checked', String(start))
  }

  private recognise(): void {
    this.parsed = parseSource(this.input.value)
    this.recognised.textContent = this.parsed
      ? `${this.parsed.description}${titleWithout(this.input.value, this.parsed) ? '' : ' — a session can give it a better title'}`
      : ''
    this.recognised.hidden = !this.parsed
  }

  private async changeFolder(): Promise<void> {
    const dir = await this.request?.pickFolder(this.cwd)
    if (!dir) return
    this.cwd = dir
    this.folder.textContent = dir
    this.folder.title = dir
  }

  private submit(): void {
    const raw = this.input.value.trim()
    if (!raw) {
      this.input.focus()
      return
    }
    const title = titleWithout(raw, this.parsed) || this.parsed?.description || raw
    this.answer({
      title,
      source: this.parsed?.source,
      notes: this.notes.value.trim() || undefined,
      cwd: this.cwd,
      start: this.start
    })
  }

  private answer(value: NewTaskResult | undefined): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = undefined
    this.root.classList.remove('visible')
    resolve(value)
    this.onClosed()
  }
}

/** One line of text to type, in the confirm dialog's shape — what a task is blocked by. */
export class TextPrompt {
  private readonly root: HTMLDivElement
  private readonly label: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly confirm: HTMLButtonElement
  private resolve?: (answer: string | undefined) => void

  constructor(private readonly onClosed: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'picker'
    const box = document.createElement('div')
    box.className = 'picker-box dialog-box'
    this.label = document.createElement('div')
    this.label.className = 'dialog-text'
    this.input = document.createElement('input')
    this.input.className = 'group-name'
    this.input.spellcheck = false
    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => this.answer(undefined))
    this.confirm = document.createElement('button')
    this.confirm.type = 'button'
    this.confirm.className = 'primary'
    this.confirm.addEventListener('click', () => this.answer(this.input.value.trim() || undefined))
    actions.append(cancel, this.confirm)
    box.append(this.label, this.input, actions)
    this.root.appendChild(box)
    document.body.appendChild(this.root)
    this.root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.root) this.answer(undefined)
    })
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.answer(undefined)
      else if (ev.key === 'Enter') this.answer(this.input.value.trim() || undefined)
      else return
      ev.preventDefault()
      ev.stopPropagation()
    })
  }

  isOpen(): boolean {
    return Boolean(this.resolve)
  }

  ask(question: string, placeholder: string, confirmLabel: string): Promise<string | undefined> {
    if (this.isOpen()) return Promise.resolve(undefined)
    this.label.textContent = question
    this.input.value = ''
    this.input.placeholder = placeholder
    this.confirm.textContent = confirmLabel
    this.root.classList.add('visible')
    return new Promise((resolve) => {
      this.resolve = resolve
      this.input.focus()
    })
  }

  private answer(value: string | undefined): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = undefined
    this.root.classList.remove('visible')
    resolve(value)
    this.onClosed()
  }
}
