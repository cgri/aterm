import type { TabGroupColor, TabKind } from '@shared/types'

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

export interface TabGroupViewModel {
  id: string
  /** Absent = nameless: the header is the colour swatch alone. */
  name?: string
  color: TabGroupColor
  collapsed: boolean
  /**
   * This group holds the tab that is in front. While it is folded up, that tab has no
   * button of its own, so the header wears the marker in its place.
   */
  active: boolean
}

/**
 * The bar is drawn from a segmented list rather than a flat one plus a second list of
 * groups: the renderer already walks the tabs in their drawn order, so it knows where
 * each group begins and ends, and deriving that a second time here is how the two
 * would eventually come to disagree.
 */
export type StripItem =
  | { kind: 'tab'; tab: TabViewModel }
  | { kind: 'group'; group: TabGroupViewModel; tabs: TabViewModel[] }

/** What is being dragged: a single tab, or a whole group by its header. */
export type DragSource = { kind: 'tab'; id: string } | { kind: 'group'; id: string }

/** Where it was let go. What that means for group membership is the renderer's call. */
export type DropTarget =
  | { kind: 'before'; tabId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'end' }

export interface TabBarHandlers {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click on a tab. The tab is not selected by it. */
  onMenu: (id: string) => void
  onNew: () => void
  onMove: (source: DragSource, target: DropTarget) => void
  /** Left-click on a group header. */
  onGroupToggle: (groupId: string) => void
  /** Right-click on a group header. */
  onGroupMenu: (groupId: string) => void
}

export class TabBar {
  private dragging?: DragSource
  /** The element currently carrying the insertion marker, so it can be cleared again. */
  private marked?: HTMLElement

  /**
   * `trailing` is put at the right end of the bar and survives every re-render —
   * rendering replaces the whole bar, so nothing may be appended from outside.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: TabBarHandlers,
    private readonly trailing: HTMLElement[] = []
  ) {}

  render(items: StripItem[], activeId: string | undefined): void {
    // Whatever was marked belongs to the bar that is about to be thrown away.
    this.marked = undefined

    // Only the tabs go into the strip, and only the strip clips: everything
    // after it — the new-tab button, the drag handle, the trailing buttons —
    // keeps its room however many tabs there are. Putting the tabs straight into
    // the bar pushed all of that out of the window once they filled it, which
    // left the title bar with no free space to drag it by.
    const strip = document.createElement('div')
    strip.id = 'tabstrip'
    for (const item of items) {
      if (item.kind === 'tab') {
        strip.appendChild(this.renderTab(item.tab, item.tab.id === activeId))
      } else {
        strip.appendChild(this.renderGroup(item.group, item.tabs, activeId))
      }
    }

    // The free space behind the last tab is a drop target of its own: "here, and in
    // no group". `ev.target === strip` is what keeps it from also answering for a
    // drop that came from a tab — those stop themselves, but the guard is what makes
    // that true rather than merely likely.
    strip.addEventListener('dragover', (ev) => {
      if (ev.target !== strip || !this.dragging) return
      ev.preventDefault()
      this.clearMark()
    })
    strip.addEventListener('drop', (ev) => {
      if (ev.target !== strip) return
      ev.preventDefault()
      this.drop({ kind: 'end' })
    })

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

  private renderGroup(
    group: TabGroupViewModel,
    tabs: TabViewModel[],
    activeId: string | undefined
  ): HTMLElement {
    const el = document.createElement('div')
    el.className = 'tabgroup'
    el.dataset.groupColor = group.color
    if (group.collapsed) el.dataset.collapsed = ''

    el.appendChild(this.renderGroupHead(group, tabs))
    if (!group.collapsed) {
      for (const tab of tabs) el.appendChild(this.renderTab(tab, tab.id === activeId, group.id))
    }
    return el
  }

  private renderGroupHead(group: TabGroupViewModel, tabs: TabViewModel[]): HTMLElement {
    const el = document.createElement('div')
    // Only a folded group speaks for the tab in front of it; an open one has that tab
    // drawn right next to it, wearing the marker itself.
    const active = group.collapsed && group.active
    el.className = `tabgroup-head${active ? ' active' : ''}`
    el.draggable = true
    el.dataset.groupColor = group.color
    el.title = group.collapsed ? 'Expand group' : 'Collapse group'

    const swatch = document.createElement('span')
    swatch.className = 'tabgroup-swatch'
    el.appendChild(swatch)

    if (group.name) {
      const name = document.createElement('span')
      name.className = 'tabgroup-name'
      name.textContent = group.name
      el.appendChild(name)
    }

    if (group.collapsed) {
      const count = document.createElement('span')
      count.className = 'tabgroup-count'
      count.textContent = String(tabs.length)
      el.appendChild(count)

      // With the members folded away the header speaks for them — otherwise a tab
      // waiting for input in there would ask and nobody would see it.
      const state = groupDot(tabs)
      if (state) {
        const dot = document.createElement('span')
        dot.className = `dot ${state}`
        dot.title = dotTitle(state)
        el.appendChild(dot)
      }
    }

    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) this.handlers.onGroupToggle(group.id)
    })
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.handlers.onGroupMenu(group.id)
    })

    this.installDrag(el, {
      source: { kind: 'group', id: group.id },
      target: { kind: 'group', groupId: group.id },
      groupId: group.id
    })
    return el
  }

  private renderTab(tab: TabViewModel, active: boolean, groupId?: string): HTMLElement {
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
    folder.textContent = tab.summary ? `${tab.folder} - ` : tab.folder
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
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.handlers.onMenu(tab.id)
    })

    this.installDrag(el, {
      source: { kind: 'tab', id: tab.id },
      target: { kind: 'before', tabId: tab.id },
      groupId
    })

    return el
  }

  /**
   * Every tab and every group header is both a drag source and a drop target. The
   * marker saying where a drop would land sits on the target, and `dragleave` alone
   * cannot clear it — it does not fire when the drag ends over the element — so the
   * bar remembers what it marked and clears that on `dragend` as well.
   */
  private installDrag(
    el: HTMLElement,
    opts: {
      source: DragSource
      target: DropTarget
      /** The group this element is part of; a group dropped on its own parts does nothing. */
      groupId?: string
    }
  ): void {
    el.addEventListener('dragstart', (ev) => {
      // A tab inside a group would otherwise start the group's drag as well.
      ev.stopPropagation()
      this.dragging = opts.source
      el.classList.add('dragging')
    })
    el.addEventListener('dragend', () => {
      this.dragging = undefined
      el.classList.remove('dragging')
      this.clearMark()
    })
    el.addEventListener('dragover', (ev) => {
      if (this.isNoop(opts)) return
      ev.preventDefault()
      ev.stopPropagation()
      this.mark(el)
    })
    el.addEventListener('dragleave', () => {
      if (this.marked === el) this.clearMark()
    })
    el.addEventListener('drop', (ev) => {
      if (this.isNoop(opts)) return
      ev.preventDefault()
      ev.stopPropagation()
      this.drop(opts.target)
    })
  }

  /** Would this drop move anything? Letting a thing go over itself does not. */
  private isNoop(opts: { source: DragSource; groupId?: string }): boolean {
    const dragged = this.dragging
    if (!dragged) return true
    if (dragged.kind === 'tab') return opts.source.kind === 'tab' && opts.source.id === dragged.id
    // A whole group: its own header and every one of its own tabs are no-ops.
    return opts.groupId === dragged.id
  }

  private mark(el: HTMLElement): void {
    if (this.marked === el) return
    this.clearMark()
    el.classList.add('drop-before')
    this.marked = el
  }

  private clearMark(): void {
    this.marked?.classList.remove('drop-before')
    this.marked = undefined
  }

  private drop(target: DropTarget): void {
    const source = this.dragging
    this.clearMark()
    if (source) this.handlers.onMove(source, target)
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

/**
 * What a collapsed group shows in place of its members' dots: the strongest state any
 * one of them is in. The precedence `dotClass` uses within a single tab, applied across
 * several — an unanswered wait first, because that is the state asking for something,
 * and a process that ended last, because it is news but asks nothing.
 *
 * Nothing at all when there is none of that: the colour swatch is what identifies the
 * group, and an idle grey dot beside it would only compete with it.
 */
function groupDot(tabs: TabViewModel[]): string | undefined {
  const strongest =
    tabs.find((tab) => tab.status === 'running' && tab.awaitingInput && !tab.awaitingSeen) ??
    tabs.find((tab) => tab.status === 'running' && tab.awaitingInput) ??
    tabs.find((tab) => tab.status === 'running' && tab.working) ??
    tabs.find((tab) => tab.status === 'exited')
  return strongest ? dotClass(strongest) : undefined
}

function dotTitle(state: string): string {
  if (state.startsWith('awaiting')) return 'A tab is waiting for input'
  if (state.endsWith('working')) return 'A tab is working'
  return 'A tab has exited'
}
