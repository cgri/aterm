import type { TabKind } from '@shared/types'

export interface TabViewModel {
  id: string
  /** The whole name, folder and summary together — what the tooltip shows. */
  title: string
  /** The directory the tab works in, drawn in front and stepped back. */
  folder: string
  /** What the session is about, if anything is known about it yet. */
  summary?: string
  kind: TabKind
  status: 'stopped' | 'running' | 'exited'
  /** A shell tab with a Claude process running inside it. */
  agentRunning: boolean
  /** The program in this tab says it is working on something. */
  working: boolean
  /** The program in this tab says it is waiting for input. */
  awaitingInput: boolean
  /** The user has had this tab on screen since it started waiting. */
  awaitingSeen: boolean
}

export interface TabBarHandlers {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReorder: (draggedId: string, beforeId: string | undefined) => void
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
    // Only the tabs go into the strip, and only the strip clips: everything
    // after it — the new-tab button, the drag handle, the trailing buttons —
    // keeps its room however many tabs there are. Putting the tabs straight into
    // the bar pushed all of that out of the window once they filled it, which
    // left the title bar with no free space to drag it by.
    const strip = document.createElement('div')
    strip.id = 'tabstrip'
    for (const tab of tabs) {
      strip.appendChild(this.renderTab(tab, tab.id === activeId))
    }

    const plus = document.createElement('button')
    plus.id = 'newtab'
    plus.textContent = '+'
    plus.title = 'New tab (Ctrl+T)'
    plus.addEventListener('click', () => this.handlers.onNew())

    // The handle is what is left over, down to a minimum the tabs cannot eat
    // into — the one stretch of the title bar that is always there to grab.
    const handle = document.createElement('div')
    handle.id = 'draghandle'

    this.root.replaceChildren(strip, plus, handle, ...this.trailing)
  }

  private renderTab(tab: TabViewModel, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}`
    el.draggable = true
    el.dataset.id = tab.id
    el.title = tab.title

    const dot = document.createElement('span')
    dot.className = `dot ${dotClass(tab)}`
    if (tab.awaitingInput) {
      dot.title = 'Waiting for input'
    } else if (tab.working) {
      dot.title = 'Working'
    }
    el.appendChild(dot)

    // Folder and summary are wrapped together so the tab's own gap stays between
    // dot, name and close button — inside the name, the separator does the
    // spacing. The separator belongs to the folder: it steps back with it, and it
    // is gone with it when there is no summary to separate from.
    const name = document.createElement('span')
    name.className = 'name'

    const folder = document.createElement('span')
    folder.className = 'folder'
    // The space after the dash has to be a non-breaking one: the folder is a flex
    // item of its own, and a trailing ordinary space at the end of a line box is
    // dropped, which would glue the summary to the dash.
    folder.textContent = tab.summary ? `${tab.folder} -\u00a0` : tab.folder
    name.appendChild(folder)

    if (tab.summary) {
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = tab.summary
      name.appendChild(label)
    }
    el.appendChild(name)

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
  // Waiting beats working: it is the one state that asks something of the user.
  if (tab.awaitingInput) return tab.awaitingSeen ? 'awaiting seen' : 'awaiting'
  // Working is a modifier on the running dot, not a colour of its own: what the
  // colour says about the tab does not change just because something is going on
  // in it.
  const base = tab.agentRunning || tab.kind === 'claude' ? 'agent' : 'running'
  return tab.working ? `${base} working` : base
}
