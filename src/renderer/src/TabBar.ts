import type { TabKind } from '@shared/types'

export interface TabViewModel {
  id: string
  title: string
  kind: TabKind
  status: 'stopped' | 'running' | 'exited'
  /** A shell tab with a Claude process running inside it. */
  agentRunning: boolean
  /** The program in this tab says it is waiting for input. */
  awaitingInput: boolean
  /** The user has seen it waiting and asked for quiet. */
  awaitingAcked: boolean
}

export interface TabBarHandlers {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReorder: (draggedId: string, beforeId: string | undefined) => void
  onDismissAwaiting: (id: string) => void
}

export class TabBar {
  private dragging?: string

  /**
   * `trailing` is put at the right end of the bar and survives every re-render —
   * rendering replaces the whole bar, so nothing may be appended from outside.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: TabBarHandlers,
    private readonly trailing: HTMLElement[] = []
  ) {}

  render(tabs: TabViewModel[], activeId: string | undefined): void {
    this.root.replaceChildren()

    for (const tab of tabs) {
      this.root.appendChild(this.renderTab(tab, tab.id === activeId))
    }

    const plus = document.createElement('button')
    plus.id = 'newtab'
    plus.textContent = '+'
    plus.title = 'New tab (Ctrl+T)'
    plus.addEventListener('click', () => this.handlers.onNew())
    this.root.appendChild(plus)

    this.root.append(...this.trailing)
  }

  private renderTab(tab: TabViewModel, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}`
    el.draggable = true
    el.dataset.id = tab.id
    el.title = tab.title

    const dot = document.createElement('span')
    dot.className = `dot ${dotClass(tab)}`
    if (tab.awaitingInput && tab.awaitingAcked) {
      dot.title = 'Waiting for input'
    } else if (tab.awaitingInput) {
      dot.title = 'Waiting for input — double-click to dismiss'
      // Dismissing on mousedown for the same reason the close button does: the
      // first press selects the tab and re-renders the bar, so this node is gone
      // before any click or dblclick could be delivered to it. `detail` counts
      // the press within the click sequence, which the browser derives from time
      // and position rather than from the node, so the dot rendered in between
      // still sees the second press as detail 2.
      dot.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0 || ev.detail !== 2) return
        ev.preventDefault()
        ev.stopPropagation()
        this.handlers.onDismissAwaiting(tab.id)
      })
    }
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
  // Waiting beats running: it is the one state that asks something of the user.
  if (tab.awaitingInput) return tab.awaitingAcked ? 'awaiting acked' : 'awaiting'
  return tab.agentRunning || tab.kind === 'claude' ? 'agent' : 'running'
}
