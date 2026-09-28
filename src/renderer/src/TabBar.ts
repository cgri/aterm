import type { TabGroupColor } from '@shared/types'
import { icon } from './icons'

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

/**
 * The new-tab page's own tab. It is always the last one in the strip, belongs to no
 * group and cannot be dragged: it stands for a page that is about to become a tab, not
 * for a tab that has a place of its own yet.
 */
export interface PageTabViewModel {
  active: boolean
  /** Without another tab to go back to, the page is all there is and stays. */
  closable: boolean
}

/** What is being dragged: a single tab, or a whole group by its header. */
export type DragSource = { kind: 'tab'; id: string } | { kind: 'group'; id: string }

/**
 * Where it was let go, already settled: in front of which tab (none = the end of the
 * bar), and in which group (none = loose). The bar decides both from the pointer's
 * position, because that is also what the insertion marker shows — a drop lands where
 * the marker was. A dragged group only ever gets `before`, and always the first tab of
 * a whole unit.
 */
export interface DropTarget {
  before?: string
  groupId?: string
}

/**
 * How far into a group, from either edge, a tab still counts as dropped *beside* the
 * group rather than into it. Without it, the space between two groups would be two
 * pixels wide.
 */
const GROUP_EDGE = 12

/** One unit of the strip — a loose tab or a whole group — with the element that draws it. */
interface Unit {
  el: HTMLElement
  item: StripItem
  /** The tab a drop in front of this unit lands in front of. */
  first: string
}

/** A computed drop, with where to draw its preview. */
interface Drop {
  target: DropTarget
  /** Viewport x of the insertion line, or the folded header the tab would disappear into. */
  mark: { x: number } | { into: HTMLElement }
}

export interface TabBarHandlers {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click on a tab. The tab is not selected by it. */
  onMenu: (id: string) => void
  onNew: () => void
  onPageSelect: () => void
  onPageClose: () => void
  onMove: (source: DragSource, target: DropTarget) => void
  /** Left-click on a group header. */
  onGroupToggle: (groupId: string) => void
  /** Right-click on a group header. */
  onGroupMenu: (groupId: string) => void
}

export class TabBar {
  private dragging?: DragSource
  /** What the strip was last drawn from, and the element drawing each unit of it. */
  private units: Unit[] = []
  /** The strip those units are in. What it clips away cannot be dropped on. */
  private strip?: HTMLElement
  /** The insertion line. It lives in the bar, not the strip, so the strip cannot clip it. */
  private readonly marker = document.createElement('div')
  /** The folded header carrying the "into this group" preview, so it can be cleared. */
  private into?: HTMLElement

  /**
   * `trailing` is put at the right end of the bar and survives every re-render —
   * rendering replaces the whole bar, so nothing may be appended from outside.
   *
   * Dropping is handled once, on the bar itself, and decided from the pointer's x alone:
   * which element happens to be under it says too little. The gap between two groups is
   * two pixels, the end of a group has no element of its own, and the whole bar behind the
   * last tab means the same thing. So every drag event of the bar ends up here.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: TabBarHandlers,
    private readonly trailing: HTMLElement[] = []
  ) {
    this.marker.className = 'drop-marker'

    root.addEventListener('dragover', (ev) => {
      if (!this.dragging) return
      const drop = this.dropAt(ev.clientX)
      this.preview(drop)
      if (!drop) return
      // Only a drop that moves something is accepted; anything else shows no marker and
      // the pointer says it would do nothing.
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    })
    root.addEventListener('dragleave', (ev) => {
      if (!root.contains(ev.relatedTarget as Node | null)) this.preview(undefined)
    })
    root.addEventListener('drop', (ev) => {
      const source = this.dragging
      const drop = source && this.dropAt(ev.clientX)
      this.endDrag()
      if (!source || !drop) return
      ev.preventDefault()
      this.handlers.onMove(source, drop.target)
    })
  }

  render(items: StripItem[], activeId: string | undefined, page?: PageTabViewModel): void {
    // Whatever was marked belongs to the bar that is about to be thrown away.
    this.into = undefined
    this.units = []

    // Only the tabs go into the strip, and only the strip clips: everything
    // after it — the new-tab button, the drag handle, the trailing buttons —
    // keeps its room however many tabs there are. Putting the tabs straight into
    // the bar pushed all of that out of the window once they filled it, which
    // left the title bar with no free space to drag it by.
    const strip = document.createElement('div')
    strip.id = 'tabstrip'
    this.strip = strip
    for (const item of items) {
      const el =
        item.kind === 'tab'
          ? this.renderTab(item.tab, item.tab.id === activeId)
          : this.renderGroup(item.group, item.tabs, activeId)
      strip.appendChild(el)
      const first = item.kind === 'tab' ? item.tab.id : item.tabs[0]?.id
      if (first) this.units.push({ el, item, first })
    }
    if (page) strip.appendChild(this.renderPageTab(page))

    const plus = document.createElement('button')
    plus.id = 'newtab'
    plus.appendChild(icon('plus'))
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
    // A folded group speaks for its members, and it does so with the same tab-shaped
    // ground a tab uses — not on the chip, which stays the group's own colour. An open
    // group says nothing: each of its tabs is on show and says it for itself.
    const alarm = group.collapsed && tabs.some((tab) => tab.alarm)
    const working = group.collapsed && !alarm && tabs.some((tab) => tab.working)

    const el = document.createElement('div')
    el.className = ['tabgroup', alarm ? 'alarm' : working ? 'working' : '']
      .filter(Boolean)
      .join(' ')
    el.dataset.groupColor = group.color
    if (group.collapsed) el.dataset.collapsed = ''

    el.appendChild(this.renderGroupHead(group, tabs, alarm, working))
    if (!group.collapsed) {
      for (const tab of tabs) el.appendChild(this.renderTab(tab, tab.id === activeId))
    }
    return el
  }

  private renderGroupHead(
    group: TabGroupViewModel,
    tabs: TabViewModel[],
    alarm: boolean,
    working: boolean
  ): HTMLElement {
    const el = document.createElement('div')
    // Only a folded group stands in for the tab in front of the user; an open one has
    // that tab drawn beside it, wearing the marker itself. What the members are up to is
    // drawn on the group, not here — the chip keeps its own colour.
    const active = group.collapsed && group.active

    el.className = `tabgroup-head${active ? ' active' : ''}`
    el.draggable = true
    el.dataset.groupColor = group.color
    // The header has no mark of its own, and a folded one no longer shows how many tabs
    // it holds, so both have to be said here.
    el.title = group.collapsed
      ? `Expand group (${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'})${
          alarm ? ' — a tab is waiting for input' : working ? ' — a tab is working' : ''
        }`
      : 'Collapse group'

    // The header is a filled chip in the group's colour with its name written inside,
    // which is the group's whole identity — there is no separate swatch beside it, and a
    // nameless group is the same chip at its minimum width rather than a bare dot.
    const name = document.createElement('span')
    name.className = 'tabgroup-name'
    name.textContent = group.name ?? ''
    el.appendChild(name)

    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) this.handlers.onGroupToggle(group.id)
    })
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.handlers.onGroupMenu(group.id)
    })

    this.installDrag(el, { kind: 'group', id: group.id })
    return el
  }

  private renderPageTab(page: PageTabViewModel): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab page-tab${page.active ? ' active' : ''}`
    el.title = 'New tab'

    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.appendChild(icon('search'))
    el.appendChild(mark)

    const name = document.createElement('span')
    name.className = 'name'
    const label = document.createElement('span')
    label.className = 'folder'
    label.textContent = 'New tab'
    name.appendChild(label)
    el.appendChild(name)

    if (page.closable) el.appendChild(this.closeButton(() => this.handlers.onPageClose()))

    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) this.handlers.onPageSelect()
      if (ev.button === 1 && page.closable) this.handlers.onPageClose()
    })
    // No menu of its own: nothing on it applies to a page that is not a tab yet.
    el.addEventListener('contextmenu', (ev) => ev.preventDefault())
    return el
  }

  private closeButton(onClose: () => void): HTMLElement {
    const close = document.createElement('span')
    close.className = 'close'
    close.appendChild(icon('close'))
    close.title = 'Close (Ctrl+W)'
    // Closing on mousedown, not click: selecting a tab re-renders the whole bar,
    // so this element is gone by mouseup and no click event is ever delivered.
    close.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault()
      ev.stopPropagation()
      onClose()
    })
    return close
  }

  private renderTab(tab: TabViewModel, active: boolean): HTMLElement {
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

    el.appendChild(this.closeButton(() => this.handlers.onClose(tab.id)))

    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) this.handlers.onSelect(tab.id)
      if (ev.button === 1) this.handlers.onClose(tab.id)
    })
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.handlers.onMenu(tab.id)
    })

    this.installDrag(el, { kind: 'tab', id: tab.id })

    return el
  }

  /** Every tab and every group header can be dragged; where it lands is the bar's call. */
  private installDrag(el: HTMLElement, source: DragSource): void {
    el.addEventListener('dragstart', (ev) => {
      // A tab inside a group would otherwise start the group's drag as well.
      ev.stopPropagation()
      this.dragging = source
      el.classList.add('dragging')
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
    })
    // `drop` ends the drag too, but a drag let go anywhere else has only this.
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging')
      this.endDrag()
    })
  }

  private endDrag(): void {
    this.dragging = undefined
    this.preview(undefined)
  }

  /**
   * What letting go at `x` would do, or nothing if it would move nothing. A tab lands on
   * the side of the tab under the pointer that the pointer is on, in that tab's group; a
   * group header takes it in at the end; and the outer `GROUP_EDGE` of a group, with the
   * gap beside it, puts it next to the group rather than into it.
   */
  private dropAt(x: number): Drop | undefined {
    const source = this.dragging
    if (!source || this.units.length === 0) return undefined
    const drop = source.kind === 'tab' ? this.tabDropAt(x) : this.groupDropAt(x)
    return this.moves(source, drop.target) ? drop : undefined
  }

  private tabDropAt(x: number): Drop {
    const { unit, index } = this.unitAt(x)
    if (!unit) return this.atEnd()
    const rect = unit.el.getBoundingClientRect()
    const after = this.units[index + 1]?.first

    if (unit.item.kind === 'tab') {
      return x < (rect.left + rect.right) / 2
        ? { target: { before: unit.first }, mark: { x: rect.left } }
        : { target: { before: after }, mark: { x: rect.right } }
    }

    if (x < rect.left + GROUP_EDGE) {
      return { target: { before: unit.first }, mark: { x: rect.left } }
    }
    if (x > rect.right - GROUP_EDGE) {
      return { target: { before: after }, mark: { x: rect.right } }
    }

    // Folded, the header is all there is of the group: it takes the tab in at the end,
    // and it is the header that shows it.
    const groupId = unit.item.group.id
    const [head, ...members] = [...unit.el.children] as HTMLElement[]
    const last = members[members.length - 1]
    const atGroupEnd: Drop = {
      target: { before: after, groupId },
      mark: last ? { x: last.getBoundingClientRect().right } : { into: head }
    }
    if (unit.item.group.collapsed || x <= head.getBoundingClientRect().right) return atGroupEnd

    for (let i = 0; i < members.length; i++) {
      const box = members[i].getBoundingClientRect()
      if (x > box.right && i < members.length - 1) continue
      if (x < (box.left + box.right) / 2) {
        return { target: { before: unit.item.tabs[i].id, groupId }, mark: { x: box.left } }
      }
      if (i === members.length - 1) return atGroupEnd
      return { target: { before: unit.item.tabs[i + 1].id, groupId }, mark: { x: box.right } }
    }
    return atGroupEnd
  }

  /** A whole group moves between whole units only: in front of one or behind it. */
  private groupDropAt(x: number): Drop {
    const { unit, index } = this.unitAt(x)
    if (!unit) return this.atEnd()
    const rect = unit.el.getBoundingClientRect()
    return x < (rect.left + rect.right) / 2
      ? { target: { before: unit.first }, mark: { x: rect.left } }
      : { target: { before: this.units[index + 1]?.first }, mark: { x: rect.right } }
  }

  /**
   * The unit `x` falls on, a gap counting to the unit before it. None: behind the last,
   * or past the strip's edge — a unit clipped off there is not on screen to be aimed at.
   */
  private unitAt(x: number): { unit?: Unit; index: number } {
    if (x > this.visibleRight()) return { index: this.units.length }
    for (let index = 0; index < this.units.length; index++) {
      const unit = this.units[index]
      if (x <= unit.el.getBoundingClientRect().right + 1) return { unit, index }
    }
    return { index: this.units.length }
  }

  private atEnd(): Drop {
    const last = this.units[this.units.length - 1]
    return {
      target: {},
      mark: { x: Math.min(last.el.getBoundingClientRect().right, this.visibleRight()) }
    }
  }

  private visibleRight(): number {
    return this.strip?.getBoundingClientRect().right ?? Infinity
  }

  /** Would this drop change anything? Letting a thing go where it already is does not. */
  private moves(source: DragSource, target: DropTarget): boolean {
    const tabs: { id: string; groupId?: string }[] = this.units.flatMap(({ item }) =>
      item.kind === 'tab'
        ? [{ id: item.tab.id }]
        : item.tabs.map((tab) => ({ id: tab.id, groupId: item.group.id }))
    )
    if (source.kind === 'tab') {
      const at = tabs.findIndex((tab) => tab.id === source.id)
      if (at < 0) return false
      if (tabs[at].groupId !== target.groupId) return true
      return target.before !== source.id && target.before !== tabs[at + 1]?.id
    }
    const own = tabs.filter((tab) => tab.groupId === source.id)
    if (own.length === 0 || own.some((tab) => tab.id === target.before)) return false
    const behind = tabs[tabs.findIndex((tab) => tab.id === own[own.length - 1].id) + 1]
    return target.before !== behind?.id
  }

  /**
   * Shows where a drop would land: a line at the spot, in the colour of the group it would
   * join or a neutral one for none, or a ring round a folded header it would disappear into.
   */
  private preview(drop: Drop | undefined): void {
    this.into?.classList.remove('drop-into')
    this.into = undefined

    if (!drop || !('x' in drop.mark)) {
      this.marker.remove()
      if (drop && 'into' in drop.mark) {
        this.into = drop.mark.into
        this.into.classList.add('drop-into')
      }
      return
    }

    const groupId = drop.target.groupId
    const group = groupId
      ? this.units.find((unit) => unit.item.kind === 'group' && unit.item.group.id === groupId)
      : undefined
    if (group?.item.kind === 'group') this.marker.dataset.groupColor = group.item.group.color
    else delete this.marker.dataset.groupColor

    // The bar is the marker's containing block. One pixel back, so the two-pixel line
    // sits on the gap between two tabs rather than beside it.
    this.marker.style.left = `${drop.mark.x - this.root.getBoundingClientRect().left - 1}px`
    if (!this.marker.isConnected) this.root.appendChild(this.marker)
  }
}
