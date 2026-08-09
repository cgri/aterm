import type { TabKind } from '@shared/types'

export interface TabViewModel {
  id: string
  title: string
  kind: TabKind
  status: 'stopped' | 'running' | 'exited'
  /** A shell tab with a Claude process running inside it. */
  agentRunning: boolean
}

export interface TabBarHandlers {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: (anchor: DOMRect) => void
  onReorder: (draggedId: string, beforeId: string | undefined) => void
}

export class TabBar {
  private dragging?: string
  private plus?: HTMLButtonElement

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: TabBarHandlers
  ) {}

  /** Where the new-tab menu hangs when it is opened from the keyboard. */
  newButtonRect(): DOMRect {
    return (this.plus ?? this.root).getBoundingClientRect()
  }

  render(tabs: TabViewModel[], activeId: string | undefined): void {
    this.root.replaceChildren()

    for (const tab of tabs) {
      this.root.appendChild(this.renderTab(tab, tab.id === activeId))
    }

    const plus = document.createElement('button')
    plus.id = 'newtab'
    plus.textContent = '+'
    plus.title = 'New tab (Ctrl+T)'
    plus.addEventListener('click', () => this.handlers.onNew(plus.getBoundingClientRect()))
    this.root.appendChild(plus)
    this.plus = plus
  }

  private renderTab(tab: TabViewModel, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}`
    el.draggable = true
    el.dataset.id = tab.id
    el.title = tab.title

    const dot = document.createElement('span')
    dot.className = `dot ${dotClass(tab)}`
    el.appendChild(dot)

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = tab.title
    el.appendChild(label)

    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = '×'
    close.title = 'Close (Ctrl+W)'
    // Closing on mousedown, not click: selecting a tab re-renders the whole bar,
    // so this element is gone by mouseup and no click event is ever delivered.
    close.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault()
      ev.stopPropagation()
      this.handlers.onClose(tab.id)
    })
    el.appendChild(close)

    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) this.handlers.onSelect(tab.id)
      if (ev.button === 1) this.handlers.onClose(tab.id)
    })

    el.addEventListener('dragstart', () => {
      this.dragging = tab.id
      el.classList.add('dragging')
    })
    el.addEventListener('dragend', () => {
      this.dragging = undefined
      el.classList.remove('dragging')
    })
    el.addEventListener('dragover', (ev) => ev.preventDefault())
    el.addEventListener('drop', (ev) => {
      ev.preventDefault()
      if (this.dragging && this.dragging !== tab.id) {
        this.handlers.onReorder(this.dragging, tab.id)
      }
    })

    return el
  }
}

function dotClass(tab: TabViewModel): string {
  if (tab.status === 'exited') return 'exited'
  if (tab.status === 'stopped') return ''
  return tab.agentRunning || tab.kind === 'claude' ? 'agent' : 'running'
}
