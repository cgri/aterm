import type { TabGroupColor } from '@shared/types'

/** Claude Code's own marker, with the variation selector that keeps it out of emoji. */
const AGENT_MARK = '✳︎'
const SHELL_MARK = '❯'

export interface TabViewModel {
  id: string
  /** The whole name, folder and summary together — what the tooltip shows. */
  title: string
  /** The directory the tab works in, drawn in front and stepped back. */
  folder: string
  /** What the session is about, if anything is known about it yet. */
  summary?: string
  /** What runs in this tab, rather than what it was started as. */
  agent: boolean
  /** There is a live process. Without one the tab wears its mark faintly. */
  running: boolean
  /** The program in this tab says it is working on something. */
  working: boolean
  /** Waiting for input and not looked at since — the one thing the bar asks about. */
  alarm: boolean
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
    // Only a folded group speaks for its tabs — for the one in front of the user, and
    // for what the rest are up to. An open group has each of them drawn next to it,
    // saying it themselves.
    const active = group.collapsed && group.active
    const alarm = group.collapsed && tabs.some((tab) => tab.alarm)
    const working = group.collapsed && !alarm && tabs.some((tab) => tab.working)

    el.className = ['tabgroup-head', active ? 'active' : '', alarm ? 'alarm' : working ? 'working' : '']
      .filter(Boolean)
      .join(' ')
    el.draggable = true
    el.dataset.groupColor = group.color
    // The header has no mark of its own, so what it is reporting has to be said here.
    el.title = group.collapsed
      ? alarm
        ? 'Expand group — a tab is waiting for input'
        : working
          ? 'Expand group — a tab is working'
          : 'Expand group'
      : 'Collapse group'

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
    // Waiting beats working, the way it always has — one place now rather than a
    // function of its own, because there are only the two states left.
    el.className = [
      'tab',
      active ? 'active' : '',
      tab.alarm ? 'alarm' : tab.working ? 'working' : ''
    ]
      .filter(Boolean)
      .join(' ')
    el.draggable = true
    el.dataset.id = tab.id
    el.title = tab.title

    // Not a state any more: it says what kind of tab this is, and goes faint when
    // nothing is running in it. What the tab is *doing* is the breath behind it.
    const mark = document.createElement('span')
    mark.className = `mark${tab.running ? '' : ' idle'}`
    mark.textContent = tab.agent ? AGENT_MARK : SHELL_MARK
    mark.title = tab.agent ? 'Claude Code' : 'Terminal'
    el.appendChild(mark)

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
