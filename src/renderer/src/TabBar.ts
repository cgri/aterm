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
 * Where it lands: in front of which tab (none = the end of the bar), and in which group
 * (none = loose). The bar works both out from the pointer's position while the drag is
 * still going on, and moves the dragged tab there as a preview — so a drop is simply
 * the preview made real. A dragged group only ever gets `before`, and always the first
 * tab of a whole unit.
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

/**
 * How the bar's parts glide into their new places. Short, because it runs on every drag
 * step and must never be what the user waits for. The id is what tells these apart from
 * any other animation on the element, so only they are cancelled when the next one starts.
 *
 * It runs whatever `prefers-reduced-motion` says, unlike the breath. Windows reports
 * "reduce" whenever its animation effects are off, which is often a policy rather than
 * anyone's choice, and then nobody saw the glide at all. It is also not decoration: it is
 * how the eye follows which tab moved where, and it is short enough not to be felt.
 */
const SLIDE = 'slide'
const SLIDE_TIMING: KeyframeAnimationOptions = { id: SLIDE, duration: 150, easing: 'ease-out' }

/**
 * What the drag shows under the pointer: nothing. The dragged tab is already drawn where it
 * would land, and the browser's own half-transparent copy of it, floating over the bar, only
 * covered that up. Loaded once, up front — `setDragImage` takes only what is decoded by the
 * time the drag starts.
 */
const NO_DRAG_IMAGE = new Image()
NO_DRAG_IMAGE.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * One unit of the strip — a loose tab or a whole group — as it is drawn right now, with
 * the dragged tab or group wherever the preview has put it. Read off the DOM, not off the
 * items the bar was rendered from, because the preview is exactly where the two differ.
 */
interface Unit {
  el: HTMLElement
  /** The tab a drop in front of this unit lands in front of; never the dragged one. */
  first?: string
  /** Set for a group: its id, and its members' elements — none while it is folded. */
  group?: { id: string; collapsed: boolean; members: HTMLElement[] }
}

/** A computed drop, and the folded header it would disappear into, if that is where. */
interface Drop {
  target: DropTarget
  into?: HTMLElement
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
  /** The element being dragged — a tab, or a whole group — and where it was taken from. */
  private dragEl?: HTMLElement
  private origin?: { parent: Node; next: Node | null; place: DropTarget }
  /** Where the preview has put it. None: back where it came from, and a drop does nothing. */
  private pending?: DropTarget
  /** The strip being drawn. What it clips away cannot be dropped on. */
  private strip?: HTMLElement
  /** The folded header carrying the "into this group" preview, so it can be cleared. */
  private into?: HTMLElement
  /**
   * A render asked for while a drag is going on, applied when it is over. Rendering
   * replaces every element, the dragged one included, and a drag whose element is gone
   * never gets its `dragend` — nor could the preview go on moving it.
   */
  private deferred?: Parameters<TabBar['render']>
  /** Where a drop left everything, for the render that carries the drop out to start from. */
  private carried?: Map<string, number>

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
    root.addEventListener('dragover', (ev) => {
      if (!this.dragging) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
      const drop = this.dropAt(ev.clientX)
      if (drop) this.apply(drop)
    })
    // Out of the bar, the preview goes back: letting go there moves nothing.
    root.addEventListener('dragleave', (ev) => {
      if (this.dragging && !root.contains(ev.relatedTarget as Node | null)) this.restore()
    })
    root.addEventListener('drop', (ev) => {
      const source = this.dragging
      if (!source) return
      ev.preventDefault()
      const target = this.pending
      if (target) this.carried = this.drawn()
      this.endDrag()
      if (target) this.handlers.onMove(source, target)
    })
  }

  render(items: StripItem[], activeId: string | undefined, page?: PageTabViewModel): void {
    if (this.dragging) {
      this.deferred = [items, activeId, page]
      return
    }
    // Where everything was drawn, so that what the new bar puts elsewhere can glide there.
    // A drop hands over what it measured before the drag's own render put things back.
    const drawn = this.carried ?? this.drawn()
    this.carried = undefined

    // Whatever was marked belongs to the bar that is about to be thrown away.
    this.into = undefined

    // Only the tabs go into the strip, and only the strip clips: everything
    // after it — the new-tab button, the drag handle, the trailing buttons —
    // keeps its room however many tabs there are. Putting the tabs straight into
    // the bar pushed all of that out of the window once they filled it, which
    // left the title bar with no free space to drag it by.
    const strip = document.createElement('div')
    strip.id = 'tabstrip'
    this.strip = strip
    for (const item of items) {
      if (item.kind === 'tab') {
        strip.appendChild(this.renderTab(item.tab, item.tab.id === activeId))
      } else {
        strip.appendChild(this.renderGroup(item.group, item.tabs, activeId))
      }
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
    this.glide(drawn, true)
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
    el.dataset.groupId = group.id
    if (group.collapsed) {
      el.dataset.collapsed = ''
      // Its tabs are not drawn, so the first of them is kept here for dropping in front.
      if (tabs[0]) el.dataset.first = tabs[0].id
    }

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
      // A group is dragged by its header, but it is the whole group that moves.
      const moving = source.kind === 'group' ? (el.parentElement ?? el) : el
      this.dragging = source
      this.dragEl = moving
      this.origin = {
        parent: moving.parentNode ?? this.root,
        next: moving.nextSibling,
        place: this.placeOf(moving)
      }
      moving.classList.add('dragging')
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setDragImage(NO_DRAG_IMAGE, 0, 0)
      }
    })
    // `drop` ends the drag too, but a drag let go anywhere else has only this.
    el.addEventListener('dragend', () => {
      if (!this.dragging) return
      this.restore()
      this.endDrag()
    })
  }

  private endDrag(): void {
    if (!this.dragging) return
    this.dragEl?.classList.remove('dragging')
    this.setInto(undefined)
    this.dragging = this.dragEl = this.origin = this.pending = undefined
    const deferred = this.deferred
    this.deferred = undefined
    if (deferred) this.render(...deferred)
  }

  /** Puts the dragged element back where it was taken from. */
  private restore(): void {
    this.setInto(undefined)
    this.pending = undefined
    const { dragEl, origin } = this
    if (dragEl && origin) this.slide(() => origin.parent.insertBefore(dragEl, origin.next))
  }

  /**
   * Moves the dragged element to where `drop` says, which is the whole preview: inside a
   * group it takes on the group's line and outline as any member does. A folded group has
   * no room to show it in, so there the element stays put and the header lights up.
   */
  private apply(drop: Drop): void {
    const el = this.dragEl
    const strip = this.strip
    if (!el || !strip) return

    this.setInto(drop.into)
    if (!drop.into) {
      const { before, groupId } = drop.target
      if (groupId) {
        const group = this.groupEl(groupId)
        if (!group) return
        const next = [...group.children].find((m) => (m as HTMLElement).dataset.id === before)
        this.slide(() => group.insertBefore(el, next ?? null))
      } else {
        const next = before
          ? this.units().find((unit) => unit.first === before)?.el
          : strip.querySelector(':scope > .page-tab')
        this.slide(() => strip.insertBefore(el, next ?? null))
      }
    }

    const origin = this.origin?.place
    const home = !drop.into && origin !== undefined && sameTarget(drop.target, origin)
    this.pending = home ? undefined : drop.target
  }

  /** Runs `move` and lets everything it shifted glide to its new place. */
  private slide(move: () => void): void {
    const drawn = this.drawn()
    move()
    this.glide(drawn)
  }

  /**
   * Where each tab and group header is drawn right now, by a key that outlives a render.
   * Drawn and not laid out: a part in the middle of a glide starts its next one from where
   * the eye last saw it, instead of jumping.
   */
  private drawn(): Map<string, number> {
    const drawn = new Map<string, number>()
    for (const el of this.parts()) {
      const key = partKey(el)
      if (key) drawn.set(key, el.getBoundingClientRect().left)
    }
    return drawn
  }

  /**
   * Lets every part that is now somewhere else than `drawn` says glide from there to here,
   * so the eye can follow what made room for what. With `fadeIn`, a part that was not there
   * before — a tab unfolded, opened or dropped in — fades in instead.
   */
  private glide(drawn: Map<string, number>, fadeIn = false): void {
    if (drawn.size === 0) return
    for (const el of this.parts()) {
      const key = partKey(el)
      if (!key) continue
      for (const running of el.getAnimations()) if (running.id === SLIDE) running.cancel()
      const from = drawn.get(key)
      if (from === undefined) {
        if (fadeIn) el.animate([{ opacity: 0 }, { opacity: 1 }], SLIDE_TIMING)
        continue
      }
      const dx = from - this.box(el).left
      if (Math.abs(dx) < 1) continue
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], SLIDE_TIMING)
    }
  }

  private parts(): HTMLElement[] {
    return this.strip ? [...this.strip.querySelectorAll<HTMLElement>('.tab, .tabgroup-head')] : []
  }

  /**
   * Where an element sits in the layout, in viewport x, leaving any transform out. That is
   * what hit-testing must use: while a tab glides, the frame it is drawn at is not its place,
   * and aiming at the frame would move it again and again.
   */
  private box(el: HTMLElement): { left: number; right: number } {
    let left = this.root.getBoundingClientRect().left
    for (let at: HTMLElement | null = el; at && at !== this.root; ) {
      left += at.offsetLeft
      at = at.offsetParent as HTMLElement | null
    }
    return { left, right: left + el.offsetWidth }
  }

  private setInto(head: HTMLElement | undefined): void {
    if (this.into === head) return
    this.into?.classList.remove('drop-into')
    this.into = head
    head?.classList.add('drop-into')
  }

  /**
   * Where letting go at `x` would put the dragged thing, or nothing if that is where the
   * preview already has it — which is what keeps the preview from jumping back and forth.
   * A tab lands on the side of the tab under the pointer that the pointer is on, in that
   * tab's group; a group header takes it in at the end; and the outer `GROUP_EDGE` of a
   * group, with the gap beside it, puts it next to the group rather than into it.
   */
  private dropAt(x: number): Drop | undefined {
    const source = this.dragging
    const el = this.dragEl
    if (!source || !el) return undefined
    const units = this.units()
    if (units.length === 0) return undefined

    if (source.kind === 'group') {
      // Between whole units only, since groups do not nest.
      const at = this.slotAt(x, units)
      if (units[at]?.el === el || units[at - 1]?.el === el) return undefined
      return { target: { before: units[at]?.first } }
    }

    const drop = this.tabDropAt(x, units)
    if (drop.target.before === source.id) drop.target.before = this.placeOf(el).before
    if (!drop.into && sameTarget(drop.target, this.placeOf(el))) return undefined
    return drop
  }

  private tabDropAt(x: number, units: Unit[]): Drop {
    const { unit, index } = this.unitAt(x, units)
    if (!unit) return { target: {} }
    const rect = this.box(unit.el)
    const after = units[index + 1]?.first
    const group = unit.group

    if (!group) return { target: { before: x < middle(rect) ? unit.first : after } }
    if (x < rect.left + GROUP_EDGE) return { target: { before: unit.first } }
    if (x > rect.right - GROUP_EDGE) return { target: { before: after } }

    // Folded, the header is all there is of the group: it takes the tab in at the end.
    const head = unit.el.firstElementChild as HTMLElement
    const atGroupEnd: Drop = { target: { before: after, groupId: group.id } }
    if (group.collapsed) return { ...atGroupEnd, into: head }
    if (x <= this.box(head).right) return atGroupEnd

    const members = group.members
    for (let i = 0; i < members.length; i++) {
      const box = this.box(members[i])
      if (x > box.right && i < members.length - 1) continue
      if (x < middle(box)) return { target: { before: members[i].dataset.id, groupId: group.id } }
      if (i === members.length - 1) return atGroupEnd
      return { target: { before: members[i + 1].dataset.id, groupId: group.id } }
    }
    return atGroupEnd
  }

  /** The unit `x` falls on, a gap counting to the unit before it. None: behind the last. */
  private unitAt(x: number, units: Unit[]): { unit?: Unit; index: number } {
    // A unit clipped off past the strip's edge is not on screen to be aimed at.
    if (x > this.visibleRight()) return { index: units.length }
    for (let index = 0; index < units.length; index++) {
      if (x <= this.box(units[index].el).right + 1) {
        return { unit: units[index], index }
      }
    }
    return { index: units.length }
  }

  /** The index of the unit a whole unit dropped at `x` would go in front of. */
  private slotAt(x: number, units: Unit[]): number {
    const { unit, index } = this.unitAt(x, units)
    if (!unit) return index
    return x < middle(this.box(unit.el)) ? index : index + 1
  }

  private visibleRight(): number {
    return this.strip?.getBoundingClientRect().right ?? Infinity
  }

  private units(): Unit[] {
    const units: Unit[] = []
    const dragged = this.dragEl
    for (const child of this.strip?.children ?? []) {
      const el = child as HTMLElement
      if (el.classList.contains('tabgroup')) {
        const collapsed = 'collapsed' in el.dataset
        const members = [...el.children].filter((m) => m.classList.contains('tab')) as HTMLElement[]
        // A group's first tab is where a drop in front of it goes — but not the dragged
        // tab, whose own place that is.
        const first = collapsed
          ? el.dataset.first
          : members.find((m) => m !== dragged)?.dataset.id
        units.push({ el, first, group: { id: el.dataset.groupId ?? '', collapsed, members } })
      } else if (el.classList.contains('tab') && !el.classList.contains('page-tab')) {
        units.push({ el, first: el.dataset.id })
      }
    }
    // A group whose only tab is the dragged one has no first of its own: in front of it
    // is in front of whatever follows.
    for (let i = units.length - 1; i >= 0; i--) {
      if (!units[i].first) units[i].first = units[i + 1]?.first
    }
    return units
  }

  /** Where an element is drawn right now, as the target that would put it there. */
  private placeOf(el: HTMLElement): DropTarget {
    const units = this.units()
    if (el.classList.contains('tabgroup')) {
      const at = units.findIndex((unit) => unit.el === el)
      return { before: units[at + 1]?.first }
    }
    const ids = units.flatMap((unit) =>
      unit.group && !unit.group.collapsed
        ? unit.group.members.map((m) => m.dataset.id)
        : [unit.el === el ? el.dataset.id : unit.first]
    )
    const at = ids.indexOf(el.dataset.id)
    const parent = el.parentElement
    const groupId = parent?.classList.contains('tabgroup') ? parent.dataset.groupId : undefined
    return { before: ids[at + 1], groupId }
  }

  private groupEl(groupId: string): HTMLElement | undefined {
    return this.units().find((unit) => unit.group?.id === groupId)?.el
  }
}

/** What a part of the bar is called across renders: its tab, its group, or the page. */
function partKey(el: HTMLElement): string | undefined {
  if (el.dataset.id) return el.dataset.id
  if (el.classList.contains('tabgroup-head')) return `group:${el.parentElement?.dataset.groupId}`
  if (el.classList.contains('page-tab')) return 'page'
  return undefined
}

function middle(rect: { left: number; right: number }): number {
  return (rect.left + rect.right) / 2
}

function sameTarget(a: DropTarget, b: DropTarget): boolean {
  return a.before === b.before && a.groupId === b.groupId
}
