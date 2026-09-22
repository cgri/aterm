import '@xterm/xterm/css/xterm.css'
import './theme.css'
import {
  TAB_GROUP_COLORS,
  type PersistedState,
  type RecentSession,
  type TabGroup,
  type TabGroupColor,
  type TabKind,
  type TabState
} from '@shared/types'
import { TabBar, type DropTarget, type StripItem, type TabViewModel } from './TabBar'
import { TerminalView } from './TerminalView'
import { SessionPicker } from './SessionPicker'
import { NewTabMenu, type MenuItem } from './NewTabMenu'
import { buildBindings, installKeymap, installWheelZoom, type Action } from './keymap'
import { SearchBar } from './SearchBar'
import { ZoomIndicator } from './ZoomIndicator'
import { ConfirmDialog } from './ConfirmDialog'
import { GroupDialog } from './GroupDialog'
import { ThemeToggle } from './ThemeToggle'
import { Updates } from './updates'
import { currentAppearance, onThemeChange } from './appearance'
import { folderName, projectDir } from './paths'

/** Font size the zoom percentage is relative to, and the target of a reset. */
const BASE_FONT_SIZE = 14

interface Pane {
  tab: TabState
  el: HTMLDivElement
  termHost: HTMLDivElement
  bar: HTMLDivElement
  placeholder: HTMLDivElement
  view?: TerminalView
  status: 'stopped' | 'running' | 'exited'
  exitCode?: number
  agentRunning: boolean
  /**
   * Pending request for a fresh git worktree. Deliberately not part of
   * TabState: it describes the next start, not the tab, and must not survive a
   * restart — a restored tab would otherwise branch off a second time.
   */
  worktree?: boolean
  /**
   * The title the running process set for itself. Deliberately not part of
   * TabState: it belongs to the process, not to the tab, so it must neither be
   * persisted nor overwrite the name the tab falls back to once the process is
   * gone.
   */
  ptyTitle?: string
  /** What the status marker in that title said, if there was one. */
  ptyState?: PtyState
  /**
   * The user has had this tab on screen since it started waiting — active tab,
   * window in the foreground. Until then the wait is news: the dot pulses and
   * the taskbar button flashes. Deliberately not part of TabState, for the same
   * reason as ptyState: it answers one wait of one process, and leaving the
   * waiting state retires it, so the next wait asks again.
   */
  awaitingSeen: boolean
  /**
   * The process is being ended so the tab can start again. Its exit is expected
   * then, and must not put up the "Process exited" bar between the two.
   */
  restarting: boolean
}

/** Claude Code says what it is up to in front of its window title. */
type PtyState = 'working' | 'awaiting'

const api = window.aterm
const barRoot = document.getElementById('tabbar') as HTMLElement
const paneRoot = document.getElementById('panes') as HTMLElement

const panes = new Map<string, Pane>()
let order: string[] = []
/**
 * The tab groups, by id. Where a group sits on screen is not in here — that follows
 * from `order`, which holds its members as one run (see `normalizeOrder`).
 */
const groups = new Map<string, TabGroup>()
let activeId: string | undefined
let homeDir = ''
let fontSize = Number(localStorage.getItem('fontSize') ?? BASE_FONT_SIZE)
/** sessionId → first prompt, used for titles and the "last here" bar. */
let sessionTitles = new Map<string, string>()
/**
 * Whether aterm is the window the user is looking at. A tab only counts as seen
 * while it is: switching tabs in a window that is behind something else does not
 * answer a wait.
 */
let windowFocused = document.hasFocus()

const themeToggle = new ThemeToggle()
const updates = new Updates({
  confirmInstall: (version) => confirmUpdateInstall(version),
  onClosed: () => activePane()?.view?.focus()
})

const tabBar = new TabBar(
  barRoot,
  {
    onSelect: (id) => activate(id, { start: true }),
    onClose: (id) => void closeTab(id),
    onMenu: (id) => openTabMenu(id),
    onNew: () => void openNewTabMenu(),
    onMove: (source, target) =>
      source.kind === 'tab' ? moveTab(source.id, target) : moveGroup(source.id, target),
    onGroupToggle: (groupId) => toggleGroup(groupId),
    onGroupMenu: (groupId) => openGroupMenu(groupId)
  },
  [updates.button, themeToggle.element]
)

onThemeChange(() => {
  for (const pane of panes.values()) pane.view?.setAppearance(currentAppearance())
})

const newTabMenu = new NewTabMenu(() => activePane()?.view?.focus())
const confirmDialog = new ConfirmDialog(() => activePane()?.view?.focus())
const groupDialog = new GroupDialog(() => activePane()?.view?.focus())
const searchBar = new SearchBar(() => activePane()?.view)
const zoomIndicator = new ZoomIndicator(document.body)

const picker = new SessionPicker({
  onOpen: (session) => void openSession(session),
  onNew: (cwd) => void createTab('claude', cwd),
  onFocus: (tabId) => activate(tabId, { start: true }),
  openTabFor: (sessionId) =>
    [...panes.values()].find((p) => p.tab.claudeSessionId === sessionId)?.tab.id
})

/* ------------------------------------------------------------------ Boot */

void boot()

async function boot(): Promise<void> {
  homeDir = await api.system.homeDir()

  api.pty.onData(({ tabId, data }) => panes.get(tabId)?.view?.write(data))
  api.pty.onExit(({ tabId, exitCode, killed }) => onExit(tabId, exitCode, killed))
  api.sessions.onDetected(({ tabId, sessionId }) => onSessionDetected(tabId, sessionId))
  api.sessions.onAgentActivity(({ running }) => onAgentActivity(running))
  api.system.onOpenDirectory((dir) => void createTab('claude', dir))

  const overrides = (await api.system.keymap()) as Partial<Record<Action, string[]>>

  installKeymap(
    {
      activeView: () => activePane()?.view,
      write: (data) => {
        const pane = activePane()
        if (pane && pane.status === 'running') api.pty.write(pane.tab.id, data)
      },
      newTab: (kind) => void createTab(kind, currentCwd()),
      openNewTabMenu: () => void openNewTabMenu(),
      closeActiveTab: () => {
        if (activeId) void closeTab(activeId)
      },
      restartActiveTab: () => {
        if (activeId) void restartTab(activeId)
      },
      cycleTab: (delta) => cycleTab(delta),
      selectTabByIndex: (index) => {
        // Counts what is on screen, so a folded-up group is skipped whole rather
        // than swallowing numbers the user cannot see.
        const id = reachableOrder()[index]
        if (id) activate(id, { start: true })
      },
      groupActiveTab: () => {
        if (!activeId) return
        if (otherGroups(panes.get(activeId)?.tab.groupId).length > 0) openAddToGroupMenu(activeId)
        else void newGroupFor(activeId)
      },
      toggleActiveGroup: () => {
        const group = activeId ? groupOf(activeId) : undefined
        if (group) toggleGroup(group.id)
      },
      openSessionPicker: () => void picker.show(),
      toggleSearch: () => searchBar.toggle(activePane()?.el),
      changeFontSize: (delta) => changeFontSize(delta),
      startActiveTab: () => {
        const pane = activePane()
        if (!pane || pane.status === 'running') return false
        void startPane(pane)
        return true
      },
      overlayOpen: () =>
        picker.isOpen() ||
        searchBar.isOpen() ||
        newTabMenu.isOpen() ||
        confirmDialog.isOpen() ||
        groupDialog.isOpen() ||
        updates.isOpen()
    },
    buildBindings(overrides)
  )
  installWheelZoom((delta) => changeFontSize(delta))
  installFocusGuard()
  installAttentionTracking()
  // Independent of the tabs, and nothing waits for it.
  updates.start()

  // What the launch asked for — the Explorer context menu, most of the time.
  // Taken before the tabs are restored, so the answer is there for both branches.
  const launchDirs = await api.system.takePendingDirs()

  const state = await api.state.load()
  if (state.tabs.length === 0) {
    if (launchDirs.length === 0) await createTab('powershell', homeDir)
    else for (const dir of launchDirs) await createTab('claude', dir)
    return
  }

  for (const tab of [...state.tabs].sort((a, b) => a.order - b.order)) {
    addPane(tab)
  }
  normalizeGroups(state.groups)
  // The stored flag may be stale — check at startup whether a resumable
  // conversation really exists, so the placeholder does not lie.
  await Promise.all(
    [...panes.values()].map(async (pane) => {
      const { kind, cwd, claudeSessionId } = pane.tab
      if (kind !== 'claude' || !claudeSessionId) return
      pane.tab.everStarted = await api.sessions.resumable(cwd, claudeSessionId)
    })
  )

  // Lazy: the restored tab is only displayed, not started.
  activate(state.activeTabId ?? order[0], { start: false, reveal: false })
  render()
  void refreshClaudeTitles()

  // The launch's own directory is the exception — it is started and made active,
  // because that is what clicking the entry in Explorer asked for.
  for (const dir of launchDirs) await createTab('claude', dir)
}

/* -------------------------------------------------------- Tab handling */

function addPane(tab: TabState): Pane {
  const el = document.createElement('div')
  el.className = 'pane'

  const termHost = document.createElement('div')
  termHost.style.display = 'contents'

  const placeholder = document.createElement('div')
  placeholder.className = 'placeholder'
  placeholder.addEventListener('mousedown', () => {
    const pane = panes.get(tab.id)
    if (pane && pane.status !== 'running') void startPane(pane)
  })

  const bar = document.createElement('div')
  bar.className = 'bar'

  el.append(termHost, placeholder, bar)
  paneRoot.appendChild(el)

  const pane: Pane = {
    tab,
    el,
    termHost,
    bar,
    placeholder,
    status: 'stopped',
    agentRunning: false,
    awaitingSeen: false,
    restarting: false
  }
  panes.set(tab.id, pane)
  if (!order.includes(tab.id)) order.push(tab.id)
  // A tab that names a group joins it here rather than sitting at the end alone.
  normalizeOrder()
  updatePlaceholder(pane)
  return pane
}

async function createTab(
  kind: TabKind,
  cwd: string,
  opts: {
    claudeSessionId?: string
    summary?: string
    resume?: boolean
    worktree?: boolean
    /** Only "New tab in group" sets this; a tab made any other way is loose. */
    groupId?: string
  } = {}
): Promise<void> {
  const tab: TabState = {
    id: crypto.randomUUID(),
    kind,
    cwd,
    summary: opts.summary,
    claudeSessionId: opts.claudeSessionId,
    // When resuming an existing session, the very first start must use --resume.
    everStarted: Boolean(opts.resume),
    groupId: opts.groupId,
    order: order.length
  }
  const pane = addPane(tab)
  pane.worktree = opts.worktree
  activate(tab.id, { start: false })
  await startPane(pane)
  render()
  persist()
}

async function openSession(session: RecentSession): Promise<void> {
  await createTab('claude', session.cwd, {
    claudeSessionId: session.sessionId,
    summary: session.title,
    resume: true
  })
}

async function closeTab(id: string): Promise<void> {
  const pane = panes.get(id)
  if (!pane) return

  if (pane.status === 'running') {
    const confirmed = await confirmDialog.ask({
      message: `"${paneTitle(pane)}" is still running. Close it anyway?`,
      confirmLabel: 'Close tab'
    })
    if (!confirmed) return
    // The tab may be gone by the time the dialog is answered.
    if (!panes.has(id)) return
  }

  await removeTab(id)
}

/**
 * Installing an update quits aterm, which ends every running tab. They come back as
 * placeholders like after any restart of aterm, so nothing is asked when none is
 * running — but whatever a working tab is in the middle of is cut off, and that is
 * named.
 */
async function confirmUpdateInstall(version: string): Promise<boolean> {
  const running = [...panes.values()].filter((p) => p.status === 'running')
  if (running.length === 0) return true
  const working = running.filter((p) => p.ptyState === 'working')

  const ended =
    running.length === 1 ? 'The running tab is ended' : `The ${running.length} running tabs are ended`
  let message = `aterm restarts to install ${version}. ${ended} and can be started again afterwards.`
  if (working.length === 1) message += ` "${paneTitle(working[0])}" is still working.`
  else if (working.length > 1) message += ` ${working.length} of them are still working.`

  return confirmDialog.ask({ message, confirmLabel: 'Restart and install' })
}

/**
 * Takes the tab away without asking anything. The question belongs to `closeTab`; a tab
 * whose process ended on its own has nothing left to confirm.
 */
async function removeTab(id: string): Promise<void> {
  const pane = panes.get(id)
  if (!pane) return

  await api.pty.kill(id)
  // Two tabs can end in the same moment, and the kill above is a turn of the event loop.
  if (!panes.has(id)) return
  pane.view?.dispose()
  pane.el.remove()
  panes.delete(id)
  order = order.filter((x) => x !== id)
  pruneEmptyGroups()
  normalizeOrder()

  // Only now, with the groups settled. `activate` opens the group around whatever this
  // picks, so closing the tab one was on never leaves the bar with nothing to point at.
  if (activeId === id) {
    const reachable = reachableOrder()
    activeId = reachable[reachable.length - 1]
  }
  if (order.length === 0) {
    await createTab('powershell', homeDir)
    return
  }
  activate(activeId, { start: false })
  render()
  persist()
}

/**
 * Ends the tab's process and starts it again in the same tab — a Claude tab resumes
 * its conversation, a shell tab gets a fresh shell. The new process only starts once
 * the old one is gone: resuming a session that the previous `claude` still holds
 * destroys the conversation, and starting over a running process would do exactly
 * that, because `PtyManager.start` does not wait for the kill it makes itself.
 */
async function restartTab(id: string): Promise<void> {
  const pane = panes.get(id)
  if (!pane || pane.restarting) return

  if (pane.status !== 'running') {
    activate(id, { start: true })
    return
  }

  // Only a tab in the middle of something is asked about: a restart then cuts off
  // whatever it was doing. Waiting for input, it loses nothing.
  if (pane.ptyState === 'working') {
    const confirmed = await confirmDialog.ask({
      message: `"${paneTitle(pane)}" is working. Restart it anyway?`,
      confirmLabel: 'Restart'
    })
    if (!confirmed) return
    // The dialog is no guard against the tab closing, or ending, meanwhile.
    if (!panes.has(id) || pane.restarting) return
    if (pane.status !== 'running') {
      activate(id, { start: true })
      return
    }
  }

  pane.restarting = true
  activate(id, { start: false })
  const gone = await api.pty.kill(id)
  pane.restarting = false
  if (!panes.has(id)) return

  if (!gone) {
    pane.status = 'exited'
    showBar(pane, 'Restart failed: the process did not end', [
      { key: 'Enter', label: 'start again' }
    ])
    render()
    return
  }
  await startPane(pane)
}

function openTabMenu(id: string): void {
  const pane = panes.get(id)
  if (!pane) return

  const items: MenuItem[] = [
    { label: 'Restart tab', run: () => void restartTab(id) },
    { label: 'Close tab', run: () => void closeTab(id) },
    { label: 'Add tab to new group…', run: () => void newGroupFor(id) }
  ]
  // A submenu re-fills this same overlay: `NewTabMenu.choose` closes before it runs
  // what was chosen, so opening it again from there needs nothing special.
  if (otherGroups(pane.tab.groupId).length > 0) {
    items.push({ label: 'Add tab to group…', run: () => openAddToGroupMenu(id) })
  }
  if (pane.tab.groupId) {
    items.push({ label: 'Remove tab from group', run: () => setTabGroup(id, undefined) })
  }
  newTabMenu.show(items, 'Tab')
}

/** Every group but the one a tab is already in. */
function otherGroups(groupId: string | undefined): TabGroup[] {
  return [...groups.values()].filter((group) => group.id !== groupId)
}

function openAddToGroupMenu(id: string): void {
  const pane = panes.get(id)
  if (!pane) return
  newTabMenu.show(
    [
      { label: '‹ Back', run: () => openTabMenu(id) },
      ...otherGroups(pane.tab.groupId).map((group) => ({
        label: group.name ?? 'Unnamed group',
        color: group.color,
        run: () => setTabGroup(id, group.id)
      }))
    ],
    'Add tab to group'
  )
}

async function newGroupFor(id: string): Promise<void> {
  const answer = await groupDialog.ask({
    title: 'New tab group',
    color: nextGroupColor(),
    confirmLabel: 'Create group'
  })
  // The tab may be gone by the time the dialog is answered.
  if (!answer || !panes.has(id)) return
  setTabGroup(id, createGroup(answer.color, answer.name).id)
}

function openGroupMenu(groupId: string): void {
  const group = groups.get(groupId)
  if (!group) return

  const seed = groupSeed(groupId)
  newTabMenu.show(
    [
      { label: 'Rename group…', run: () => void renameGroup(groupId) },
      { label: 'Change colour…', run: () => openGroupColorMenu(groupId) },
      {
        label: group.collapsed ? 'Expand group' : 'Collapse group',
        run: () => setGroupCollapsed(groupId, !group.collapsed)
      },
      { label: 'New tab in group', run: () => void createTab(seed.kind, seed.cwd, { groupId }) },
      { label: 'Ungroup', run: () => ungroup(groupId) },
      { label: 'Close group', run: () => void closeGroup(groupId) }
    ],
    group.name ?? 'Tab group'
  )
}

function openGroupColorMenu(groupId: string): void {
  const group = groups.get(groupId)
  if (!group) return
  newTabMenu.show(
    [
      { label: '‹ Back', run: () => openGroupMenu(groupId) },
      ...TAB_GROUP_COLORS.map((color) => ({
        label: color[0].toUpperCase() + color.slice(1),
        color,
        trailing: color === group.color ? '✓' : undefined,
        run: () => setGroupColor(groupId, color)
      }))
    ],
    'Group colour'
  )
}

async function renameGroup(groupId: string): Promise<void> {
  const group = groups.get(groupId)
  if (!group) return

  const answer = await groupDialog.ask({
    title: 'Rename tab group',
    name: group.name,
    color: group.color,
    confirmLabel: 'Rename'
  })
  // The group may have lost its last tab while the dialog was up.
  const current = groups.get(groupId)
  if (!answer || !current) return
  current.name = answer.name
  current.color = answer.color
  render()
  persist()
}

/**
 * `reveal` opens the group around the tab, and is what almost every caller wants: asking
 * for a tab means asking to see it. Restoring does not — a group the user folded up has
 * to still be folded up on the next start, even when the tab left active is inside it.
 */
function activate(id: string | undefined, opts: { start: boolean; reveal?: boolean }): void {
  if (!id || !panes.has(id)) return
  activeId = id

  if (opts.reveal !== false) {
    const group = groupOf(id)
    if (group?.collapsed) group.collapsed = false
  }

  for (const [paneId, pane] of panes) {
    pane.el.classList.toggle('active', paneId === id)
  }

  const pane = panes.get(id)!
  if (opts.start && pane.status !== 'running') {
    void startPane(pane)
  } else {
    pane.view?.refit()
    pane.view?.focus()
  }
  searchBar.detach()
  noteSeen()
  render()
  persist()
}

function cycleTab(delta: number): void {
  const reachable = reachableOrder()
  if (reachable.length < 2 || !activeId) return
  const index = reachable.indexOf(activeId)
  const next = index < 0 ? 0 : (index + delta + reachable.length) % reachable.length
  activate(reachable[next], { start: true })
}

/* ------------------------------------------------------------ Tab groups */

/** The group a tab belongs to, if it still exists. */
function groupOf(tabId: string): TabGroup | undefined {
  const groupId = panes.get(tabId)?.tab.groupId
  return groupId ? groups.get(groupId) : undefined
}

/** The tabs of a group, in the order they are drawn in. */
function groupMembers(groupId: string): string[] {
  return order.filter((id) => panes.get(id)?.tab.groupId === groupId)
}

/** The tabs with a button of their own: everything but the members of a folded group. */
function visibleOrder(): string[] {
  return order.filter((id) => !groupOf(id)?.collapsed)
}

/**
 * What the keyboard walks and what closing a tab falls back on. Normally the tabs on
 * screen — but every tab there is can be folded away at once, and Ctrl+Tab leading
 * nowhere would be a dead end. Whatever it names, `activate` unfolds the group around it.
 */
function reachableOrder(): string[] {
  const visible = visibleOrder()
  return visible.length > 0 ? visible : order
}

/** A group whose last tab is gone stops existing. */
function pruneEmptyGroups(): void {
  const alive = new Set([...panes.values()].map((pane) => pane.tab.groupId))
  for (const id of [...groups.keys()]) if (!alive.has(id)) groups.delete(id)
}

/**
 * Puts the members of every group back together and renumbers `tab.order` from the
 * result. `order` is the only truth about what is drawn where, and a group's tabs have
 * to be one run in it: that is what lets `render` segment the bar in a single pass.
 *
 * Stable and idempotent — a group that is already in one piece is not touched, and the
 * first member the walk meets is what decides where the group sits. That last part is
 * also why this must never be what *decides* membership: a tab dragged out of its block
 * would be the first one met and would pull the whole group along behind it, where the
 * user meant to take one tab out. Membership is always settled before this runs.
 */
function normalizeOrder(): void {
  const placed = new Set<string>()
  const result: string[] = []

  for (const id of order) {
    if (placed.has(id)) continue
    const groupId = panes.get(id)?.tab.groupId
    if (!groupId) {
      result.push(id)
      placed.add(id)
      continue
    }
    for (const member of groupMembers(groupId)) {
      result.push(member)
      placed.add(member)
    }
  }

  order = result
  order.forEach((id, index) => {
    const pane = panes.get(id)
    if (pane) pane.tab.order = index
  })
}

/**
 * What comes out of state.json is not to be trusted: `SessionStore` checks no more than
 * that a tab has an id and a cwd, so the groups arrive here unexamined. A group is the
 * cheaper thing to lose, so whatever does not add up costs the group and never the tab.
 */
function normalizeGroups(stored: TabGroup[] | undefined): void {
  groups.clear()

  for (const group of stored ?? []) {
    if (!group?.id || groups.has(group.id)) continue
    const name = group.name?.trim()
    groups.set(group.id, {
      id: group.id,
      name: name ? name : undefined,
      color: isGroupColor(group.color) ? group.color : 'grey',
      collapsed: Boolean(group.collapsed)
    })
  }

  for (const pane of panes.values()) {
    if (pane.tab.groupId && !groups.has(pane.tab.groupId)) delete pane.tab.groupId
  }

  pruneEmptyGroups()
  normalizeOrder()
}

function isGroupColor(value: unknown): value is TabGroupColor {
  return (TAB_GROUP_COLORS as readonly unknown[]).includes(value)
}

/** A colour no other group is wearing, so two groups are told apart without being asked. */
function nextGroupColor(): TabGroupColor {
  const taken = new Set([...groups.values()].map((group) => group.color))
  // Grey stays in the picker but is never handed out on its own — beside the seven
  // that carry a colour it reads as "no colour", which is not what a new group is.
  const offered = TAB_GROUP_COLORS.filter((color) => color !== 'grey')
  return offered.find((color) => !taken.has(color)) ?? 'grey'
}

function createGroup(color: TabGroupColor, name?: string): TabGroup {
  const group: TabGroup = { id: crypto.randomUUID(), name, color, collapsed: false }
  groups.set(group.id, group)
  return group
}

function setGroupColor(groupId: string, color: TabGroupColor): void {
  const group = groups.get(groupId)
  if (!group || group.color === color) return
  group.color = color
  render()
  persist()
}

/**
 * Joining or leaving a group, with the tab put where it can be found again: a joiner
 * lands behind the last member, a leaver behind the last one that stays. Either way the
 * block keeps its place and the tab that moved ends up next to where it came from.
 */
function setTabGroup(tabId: string, groupId: string | undefined): void {
  const pane = panes.get(tabId)
  if (!pane || pane.tab.groupId === groupId) return

  const previous = pane.tab.groupId
  if (groupId) pane.tab.groupId = groupId
  else delete pane.tab.groupId

  const home = groupId ?? previous
  if (home) placeAfter(tabId, lastMember(home, tabId))

  pruneEmptyGroups()
  normalizeOrder()
  render()
  persist()
}

/** The last tab of a group as it stands, leaving one id out of the reckoning. */
function lastMember(groupId: string, ignore: string): string | undefined {
  const members = groupMembers(groupId).filter((id) => id !== ignore)
  return members[members.length - 1]
}

/** Puts a tab directly behind `anchor`; without one it stays where it is. */
function placeAfter(tabId: string, anchor: string | undefined): void {
  if (!anchor) return
  order = order.filter((id) => id !== tabId)
  order.splice(order.indexOf(anchor) + 1, 0, tabId)
}

function toggleGroup(groupId: string): void {
  const group = groups.get(groupId)
  if (group) setGroupCollapsed(groupId, !group.collapsed)
}

/**
 * Folding a group up moves the active tab out of it when there is anywhere to move it to,
 * so the bar goes on showing which tab is in front.
 *
 * When there is not — because this group holds every tab there is, which two tabs in one
 * group is already enough for — it folds anyway and the active tab stays inside it. That
 * costs nothing: what the user is looking at is the *pane*, and it does not go away; only
 * the tab's button does, and the header takes over saying it is the one in front. Refusing
 * to fold instead was the first attempt, and it made the feature look broken the first
 * time anyone tried it.
 */
function setGroupCollapsed(groupId: string, collapsed: boolean): void {
  const group = groups.get(groupId)
  if (!group || group.collapsed === collapsed) return

  if (collapsed && activeId && panes.get(activeId)?.tab.groupId === groupId) {
    const target = nextVisibleOutside(activeId, groupMembers(groupId))
    if (target) {
      group.collapsed = true
      // `start: false`, because folding a group up is not a click on a tab and must not
      // start a process behind a placeholder. `activate` renders and persists itself.
      activate(target, { start: false })
      return
    }
  }

  group.collapsed = collapsed
  render()
  persist()
}

/**
 * Where the active tab goes when the group around it folds up: the first tab to the
 * right that is neither a member nor hidden inside some other collapsed group, wrapping
 * round at the end. Rightwards first, so the user lands just behind what they closed.
 */
function nextVisibleOutside(fromId: string, exclude: string[]): string | undefined {
  const start = order.indexOf(fromId)
  if (start < 0) return undefined
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length]
    if (exclude.includes(id) || groupOf(id)?.collapsed) continue
    return id
  }
  return undefined
}

/** Does this group hold the tab that is in front? Only a folded one says so itself. */
function holdsActiveTab(groupId: string): boolean {
  return Boolean(activeId) && panes.get(activeId!)?.tab.groupId === groupId
}

/** Every member becomes a loose tab again, and the group itself stops existing. */
function ungroup(groupId: string): void {
  for (const id of groupMembers(groupId)) {
    const pane = panes.get(id)
    if (pane) delete pane.tab.groupId
  }
  pruneEmptyGroups()
  normalizeOrder()
  render()
  persist()
}

/**
 * Closes every tab of a group behind a single question. `closeTab` would ask again for
 * each running one, which is a chain of dialogs for something asked for once.
 */
async function closeGroup(groupId: string): Promise<void> {
  const group = groups.get(groupId)
  const members = groupMembers(groupId)
  if (!group || members.length === 0) return

  const running = members.filter((id) => panes.get(id)?.status === 'running')
  const what = group.name ? `"${group.name}"` : 'this group'
  let message =
    members.length === 1
      ? `Close the tab in ${what}?`
      : `Close the ${members.length} tabs in ${what}?`
  if (running.length === 1) message += ' One of them is still running.'
  else if (running.length > 1) message += ` ${running.length} of them are still running.`

  if (!(await confirmDialog.ask({ message, confirmLabel: 'Close group' }))) return

  // A tab can end on its own while the dialog is up, so each one is checked again.
  for (const id of members) {
    if (panes.has(id)) await removeTab(id)
  }
}

/**
 * A dragged tab's group follows from where it was let go; there is no separate gesture
 * for joining and leaving. The one rule worth spelling out: dropping it *in front of the
 * first member* of a group means in front of the group, not into it — unless the tab is
 * already one of its members. Chrome tells those two apart with a hysteresis zone along
 * the edge, which needs pointer tracking; this needs no geometry at all and lands where
 * it was meant nearly every time.
 */
function moveTab(tabId: string, target: DropTarget): void {
  const pane = panes.get(tabId)
  if (!pane) return

  // Both are read while `order` and the memberships still describe the bar that was
  // dropped onto. Settling the group here, before `normalizeOrder`, is what keeps that
  // function from deciding anything — see the note on it.
  const groupId = dropGroup(tabId, target)
  const anchor = dropAnchor(tabId, target)

  if (groupId) pane.tab.groupId = groupId
  else delete pane.tab.groupId

  order = order.filter((id) => id !== tabId)
  const at = anchor ? order.indexOf(anchor) : -1
  order.splice(at < 0 ? order.length : at, 0, tabId)

  pruneEmptyGroups()
  normalizeOrder()
  render()
  persist()
}

function dropGroup(tabId: string, target: DropTarget): string | undefined {
  if (target.kind === 'end') return undefined
  if (target.kind === 'group') return target.groupId

  const ontoGroup = panes.get(target.tabId)?.tab.groupId
  if (!ontoGroup) return undefined
  if (target.tabId !== groupMembers(ontoGroup)[0]) return ontoGroup
  return panes.get(tabId)?.tab.groupId === ontoGroup ? ontoGroup : undefined
}

/** The tab the dragged one lands in front of; nothing means the end of the bar. */
function dropAnchor(tabId: string, target: DropTarget): string | undefined {
  if (target.kind === 'end') return undefined
  if (target.kind === 'before') return target.tabId
  // Dropped on a header: in front of that group's first tab, so it becomes the first.
  return groupMembers(target.groupId).filter((id) => id !== tabId)[0]
}

/**
 * A whole group, dragged by its header. Groups do not nest, so the block always lands
 * in front of a whole unit — a loose tab, or another group entire — and never inside
 * one. Nothing changes group here; only where the block sits.
 */
function moveGroup(groupId: string, target: DropTarget): void {
  const members = groupMembers(groupId)
  if (members.length === 0) return

  const anchor = groupAnchor(target)
  if (anchor && members.includes(anchor)) return

  order = order.filter((id) => !members.includes(id))
  const at = anchor ? order.indexOf(anchor) : -1
  order.splice(at < 0 ? order.length : at, 0, ...members)

  normalizeOrder()
  render()
  persist()
}

/** Where a dragged block lands: in front of a loose tab, or of a whole other group. */
function groupAnchor(target: DropTarget): string | undefined {
  if (target.kind === 'end') return undefined
  if (target.kind === 'group') return groupMembers(target.groupId)[0]
  const ontoGroup = panes.get(target.tabId)?.tab.groupId
  return ontoGroup ? groupMembers(ontoGroup)[0] : target.tabId
}

/** What a tab made inside a group should look like: whatever the group's last tab is. */
function groupSeed(groupId: string): { kind: TabKind; cwd: string } {
  const members = groupMembers(groupId)
  const last = panes.get(members[members.length - 1])
  return { kind: last?.tab.kind ?? 'claude', cwd: last?.tab.cwd ?? currentCwd() }
}

/* ------------------------------------------------------ Process start */

async function startPane(pane: Pane): Promise<void> {
  const { tab } = pane
  // Between the kill and the start of a restart the tab looks exited, and Enter or
  // switching to it would start it while the old process may still hold the session.
  if (pane.restarting) return

  if (!pane.view) {
    const view = new TerminalView(
      tab.id,
      fontSize,
      currentAppearance(),
      (data) => api.pty.write(tab.id, data),
      (cols, rows) => api.pty.resize(tab.id, cols, rows),
      (title) => setPtyTitle(pane, title)
    )
    pane.view = view
    view.open(pane.termHost)
  } else {
    pane.view.term.reset()
    // The next process names itself; until then the tab is back to its own name.
    pane.ptyTitle = undefined
    pane.ptyState = undefined
    pane.awaitingSeen = false
  }

  if (tab.kind === 'claude' && !tab.claudeSessionId) {
    tab.claudeSessionId = await api.sessions.newId()
  }

  const requested = tab.claudeSessionId
  const size = pane.view.size()
  const result = await api.pty.start({
    tabId: tab.id,
    kind: tab.kind,
    cwd: tab.cwd,
    claudeSessionId: tab.claudeSessionId,
    resume: tab.kind === 'claude' && tab.everStarted,
    worktree: pane.worktree,
    cols: size.cols,
    rows: size.rows
  })

  if (!result.ok) {
    pane.status = 'exited'
    pane.exitCode = -1
    showBar(pane, `Start failed: ${result.error ?? 'unknown error'}`, [
      { key: 'Enter', label: 'try again' }
    ])
    render()
    return
  }

  // The answer to this request only applies while nothing newer has arrived: a session
  // detected while the process was starting names the conversation it is really in, and
  // overwriting that with the id we asked for would resume the wrong one.
  if (tab.claudeSessionId === requested) {
    if (result.claudeSessionId) tab.claudeSessionId = result.claudeSessionId
    // everStarted means "a resumable conversation exists". Whether that holds is
    // decided by the main process from the transcript.
    tab.everStarted = Boolean(result.resumed)
  }
  // The worktree exists now; a later restart of this tab reuses it.
  pane.worktree = false
  pane.status = 'running'
  pane.exitCode = undefined
  hideBar(pane)
  updatePlaceholder(pane)
  pane.view.refit()
  pane.view.focus()
  offerResume(pane)
  render()
  persist()

  if (tab.kind === 'claude') void refreshClaudeTitles()
}

function onExit(tabId: string, exitCode: number, killed: boolean): void {
  const pane = panes.get(tabId)
  if (!pane) return
  pane.status = 'exited'
  pane.exitCode = exitCode
  pane.agentRunning = false
  pane.ptyTitle = undefined
  pane.ptyState = undefined
  pane.awaitingSeen = false

  // A restart asked for this exit and starts the tab again once it is through.
  if (pane.restarting) {
    render()
    return
  }

  // A program that finished cleanly takes its tab with it — that is the whole point of
  // typing `exit`. Not when aterm ended the process itself: a kill can report 0 too, and
  // on quit that would empty the tab list on the way out.
  if (!killed && exitCode === 0) {
    void removeTab(tabId)
    return
  }

  showBar(pane, `Process exited (code ${exitCode})`, [{ key: 'Enter', label: 'start again' }])
  render()
}

/* ----------------------------------------- Session detection */

/**
 * Which conversation a tab is in, as worked out by the main process: one the user
 * started inside a PowerShell tab, or one a Claude tab moved to by itself when the
 * user ran `/clear` or `/resume`. In the second case the id the process was launched
 * with is now stale, and keeping it would make the next start resume the state from
 * before the switch.
 */
function onSessionDetected(tabId: string, sessionId: string): void {
  const pane = panes.get(tabId)
  if (!pane || pane.tab.claudeSessionId === sessionId) return
  pane.tab.claudeSessionId = sessionId
  // The conversation was only reported because something was written into it, so it
  // is resumable. The main process still decides that for itself on every start.
  pane.tab.everStarted = true
  persist()
  void refreshClaudeTitles()
}

function onAgentActivity(running: Record<string, boolean>): void {
  let changed = false
  for (const [tabId, pane] of panes) {
    const next = Boolean(running[tabId])
    if (pane.agentRunning !== next) {
      pane.agentRunning = next
      changed = true
    }
  }
  if (changed) render()
}

/* ------------------------------------------------------- Attention */

/**
 * Is this tab in front of the user right now? Being the active tab is not enough
 * — the window has to be the one they are looking at, or a tab switched to while
 * aterm sits behind something else would answer a wait nobody saw.
 */
function isOnScreen(pane: Pane): boolean {
  return windowFocused && pane === activePane()
}

/**
 * The active tab has been in front of the user, so whatever it was waiting for
 * is no longer news. Answers only that one tab — the taskbar keeps flashing
 * while another tab is still waiting unseen.
 *
 * Does not render: every caller does, and one of them is `render` itself by way
 * of `activate`.
 */
function noteSeen(): void {
  const pane = activePane()
  if (pane && windowFocused && pane.ptyState === 'awaiting') pane.awaitingSeen = true
}

/**
 * Tells the main process whether the taskbar button should ask for attention.
 * Sent only on change: `render` runs on every title a process sets, and a tab
 * that is working sets one about once a second.
 */
let attentionSent = false

function updateAttention(): void {
  const wanted = [...panes.values()].some(
    (pane) => pane.ptyState === 'awaiting' && !pane.awaitingSeen
  )
  if (wanted === attentionSent) return
  attentionSent = wanted
  api.system.setAttention(wanted)
}

/**
 * The window changing hands is what turns a wait into something the user has
 * seen — and what re-arms the flash, because Windows stops it as soon as the
 * window comes to the foreground, seen or not.
 */
function installAttentionTracking(): void {
  window.addEventListener('focus', () => {
    windowFocused = true
    noteSeen()
    render()
  })
  window.addEventListener('blur', () => {
    windowFocused = false
  })
}

/* ------------------------------------------------------------ Rendering */

function render(): void {
  // One pass over `order`. A group's tabs are a run in it (`normalizeOrder`), so a tab
  // whose group differs from its predecessor's is exactly where one segment ends and
  // the next begins — nothing here has to gather a group's tabs up first.
  const items: StripItem[] = []
  let current: Extract<StripItem, { kind: 'group' }> | undefined

  for (const id of order) {
    const pane = panes.get(id)
    if (!pane) continue
    const model = tabModel(pane)
    const group = groupOf(id)

    if (!group) {
      current = undefined
      items.push({ kind: 'tab', tab: model })
      continue
    }
    if (current?.group.id !== group.id) {
      current = {
        kind: 'group',
        group: {
          id: group.id,
          name: group.name,
          color: group.color,
          collapsed: group.collapsed,
          active: holdsActiveTab(group.id)
        },
        tabs: []
      }
      items.push(current)
    }
    current.tabs.push(model)
  }

  tabBar.render(items, activeId)

  for (const pane of panes.values()) updatePlaceholder(pane)
  const active = activePane()
  document.title = active ? `${paneTitle(active)} — aterm` : 'aterm'
  updateAttention()
}

function tabModel(pane: Pane): TabViewModel {
  return {
    id: pane.tab.id,
    // The two halves are drawn apart so the folder can step back visually;
    // `title` is the whole name, for the tooltip.
    title: paneTitle(pane),
    folder: tabFolder(pane),
    summary: tabSummary(pane),
    kind: pane.tab.kind,
    status: pane.status,
    agentRunning: pane.agentRunning,
    working: pane.ptyState === 'working',
    awaitingInput: pane.ptyState === 'awaiting',
    awaitingSeen: pane.awaitingSeen
  }
}

function updatePlaceholder(pane: Pane): void {
  const show = pane.status === 'stopped'
  pane.placeholder.classList.toggle('visible', show)
  if (!show) return

  pane.placeholder.replaceChildren()

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = paneTitle(pane)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = pane.tab.cwd

  const hint = document.createElement('div')
  hint.className = 'sub'
  hint.textContent =
    pane.tab.kind === 'claude' && pane.tab.everStarted
      ? 'Enter — resume session'
      : 'Enter — open'

  pane.placeholder.append(title, sub, hint)
}

interface BarAction {
  label: string
  /** Rendered as a key hint rather than a clickable action. */
  key?: string
  onClick?: () => void
}

function showBar(pane: Pane, message: string, actions: BarAction[]): void {
  pane.bar.replaceChildren()

  const text = document.createElement('b')
  text.textContent = message
  pane.bar.appendChild(text)

  for (const action of actions) {
    if (action.key) {
      const key = document.createElement('span')
      key.className = 'key'
      key.textContent = action.key
      pane.bar.appendChild(key)
    }
    const label = document.createElement('span')
    label.textContent = action.label
    if (action.onClick) {
      label.className = 'action'
      label.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        action.onClick!()
      })
    }
    pane.bar.appendChild(label)
  }

  const dismiss = document.createElement('span')
  dismiss.className = 'action dismiss'
  dismiss.textContent = '×'
  dismiss.title = 'Dismiss'
  dismiss.addEventListener('mousedown', (ev) => {
    ev.preventDefault()
    hideBar(pane)
  })
  pane.bar.appendChild(dismiss)

  pane.bar.classList.add('visible')
}

/**
 * If a Claude session last ran in this shell tab, it is offered — but not
 * executed: a shell tab may well be meant for something else entirely.
 */
function offerResume(pane: Pane): void {
  const sessionId = pane.tab.claudeSessionId
  if (pane.tab.kind !== 'powershell' || !sessionId) return

  const label = sessionTitles.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`
  showBar(pane, `Last here: ${label}`, [
    {
      label: 'insert claude --resume',
      onClick: () => {
        api.pty.write(pane.tab.id, `claude --resume ${sessionId}`)
        hideBar(pane)
        pane.view?.focus()
      }
    }
  ])
}

function hideBar(pane: Pane): void {
  pane.bar.classList.remove('visible')
  pane.bar.replaceChildren()
}

/* ------------------------------------------------------------ Titles */

/**
 * What the tab is called right now: the folder it works in, then what the
 * session is about. The folder alone is left while nothing is known about the
 * session yet, which is also all a shell tab ever gets.
 */
function paneTitle(pane: Pane): string {
  const folder = tabFolder(pane)
  const summary = tabSummary(pane)
  return summary ? `${folder} - ${summary}` : folder
}

/**
 * The directory part of the name. A running process that names itself wins for
 * the summary, as it does in Windows Terminal, but never for the folder — where
 * a tab works is the one thing about it that does not change. A worktree tab is
 * named after its project, so the same session is recognisable whether it was
 * started fresh (cwd is the project) or reopened from the picker (cwd is the
 * worktree).
 */
function tabFolder(pane: Pane): string {
  return folderName(projectDir(pane.tab.cwd))
}

/**
 * A running process that names itself wins; the tab's own summary is what is
 * left once the process is gone.
 */
function tabSummary(pane: Pane): string | undefined {
  return pane.ptyTitle ?? pane.tab.summary
}

/**
 * Takes over the title a process set for itself. Titles arrive as often as the
 * process cares to send them and rendering rebuilds the whole tab bar, so
 * anything that does not actually change what is shown stops here.
 */
function setPtyTitle(pane: Pane, raw: string): void {
  const next = readPtyTitle(raw)
  if (next.title === pane.ptyTitle && next.state === pane.ptyState) return
  // Only the move into and out of waiting touches this. Leaving retires it, so
  // the next wait is news again; entering it is already answered if the user is
  // looking at the tab. Re-deciding it on every title would undo a tab the user
  // has since left, because Claude Code keeps rewriting the text while it waits.
  if (next.state !== 'awaiting') pane.awaitingSeen = false
  else if (pane.ptyState !== 'awaiting') pane.awaitingSeen = isOnScreen(pane)
  pane.ptyTitle = next.title
  pane.ptyState = next.state
  // Nothing persisted changed — the title belongs to the process, not the tab.
  render()
}

/**
 * ConPTY announces the image it just started as the window title, so every tab
 * would first be renamed to something like
 * `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. Nobody means that
 * as a title, and it would replace the tab's own name until the program gets
 * round to naming itself.
 */
const LAUNCHED_IMAGE = /^(?:[a-z]:[\\/]|\\\\)[^\r\n]*\.(?:exe|cmd|bat|com)$/i

/**
 * Claude Code puts its state in front of the title: a spinner while it works,
 * and ✳ while it waits for input. The dot in the tab says that better than a
 * symbol glued to the text does — and dropping the spinner is what keeps a
 * working tab from rebuilding the whole tab bar once a second, because every
 * frame is a title change of its own.
 */
// Two spinners, because the glyphs changed under us: current Claude Code
// alternates ◐ and ◑ about once a second, older versions sent a Braille frame.
// Both are matched, so an older `claude` on PATH keeps working. Escaped rather
// than literal, because the Braille range starts at U+2800, which is blank and
// would sit invisible in the source. `|$` because a marker can arrive before
// there is any summary behind it: the trailing space is gone by then, and the
// bare glyph must not end up as the tab's name.
const SPINNER_MARKER = /^[\u2800-\u28ff\u25d0\u25d1](?:\s+|$)/
const AWAITING_MARKER = /^\u2733(?:\s+|$)/

/**
 * What Claude Code calls itself when it has no summary to show: `claude` from
 * the launcher before the app is up, and `Claude Code` from the app itself for a
 * conversation it has not summarised. Neither names the tab, and taking one as a
 * title costs the tab the name it already had - the session's own title, which
 * `refreshClaudeTitles` reads out of history.jsonl. So they count as no title at
 * all, while the state marker in front of them still counts.
 */
const APP_TITLES = new Set(['claude', 'claude code'])

function readPtyTitle(raw: string): { title?: string; state?: PtyState } {
  const text = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || LAUNCHED_IMAGE.test(text)) return {}

  const marker = SPINNER_MARKER.test(text)
    ? { state: 'working' as const, pattern: SPINNER_MARKER }
    : AWAITING_MARKER.test(text)
      ? { state: 'awaiting' as const, pattern: AWAITING_MARKER }
      : undefined

  const label = marker ? text.replace(marker.pattern, '') : text
  if (!label || APP_TITLES.has(label.toLowerCase())) return { state: marker?.state }
  // The tab bar ellipsises anyway; this is only a guard against a runaway
  // sequence being carried around as a tooltip.
  return {
    title: label.length > 200 ? `${label.slice(0, 199)}…` : label,
    state: marker?.state
  }
}

async function refreshClaudeTitles(): Promise<void> {
  const sessions = await api.sessions.recent()
  sessionTitles = new Map(sessions.map((s) => [s.sessionId, s.title]))
  let changed = false

  for (const pane of panes.values()) {
    // Only agent tabs take the prompt as their summary. A shell tab stays named
    // after its directory alone — its session shows up in the inline bar.
    if (pane.tab.kind !== 'claude') continue
    const title = pane.tab.claudeSessionId
      ? sessionTitles.get(pane.tab.claudeSessionId)
      : undefined
    if (title && title !== pane.tab.summary) {
      pane.tab.summary = title
      changed = true
    }
  }
  if (changed) {
    render()
    persist()
  }
}

// The title only appears with the first prompt. Keep checking only while a
// session without a known title is actually open — history.jsonl runs to
// several hundred KB and should not be read while nothing is pending.
setInterval(() => {
  const pending = [...panes.values()].some(
    (pane) => pane.tab.claudeSessionId && !sessionTitles.has(pane.tab.claudeSessionId)
  )
  if (pending) void refreshClaudeTitles()
}, 5000)

/* ----------------------------------------------------------- New tab */

async function openNewTabMenu(): Promise<void> {
  // Ctrl+T on the open overlay closes it again.
  if (newTabMenu.isOpen()) {
    newTabMenu.close()
    return
  }

  const cwd = currentCwd()
  // `claude --worktree` needs a git working tree; offering it anywhere else
  // would just open a tab that dies with an error.
  const canWorktree = await api.system.isGitRepo(cwd)

  const items: MenuItem[] = [
    { label: 'Claude Code — current folder', run: () => void createTab('claude', cwd) }
  ]
  if (canWorktree) {
    items.push({
      label: 'Claude Code — current folder, new worktree',
      run: () => void createTab('claude', cwd, { worktree: true })
    })
  }
  items.push(
    { label: 'Claude Code — choose folder…', run: () => void createTabWithPicker('claude') },
    { label: 'PowerShell — current folder', run: () => void createTab('powershell', cwd) },
    { label: 'PowerShell — choose folder…', run: () => void createTabWithPicker('powershell') },
    { label: 'Recently opened sessions…', run: () => void picker.show() }
  )

  newTabMenu.show(items)
}

async function createTabWithPicker(kind: TabKind): Promise<void> {
  const dir = await api.system.pickFolder(currentCwd())
  if (dir) await createTab(kind, dir)
}

function currentCwd(): string {
  return activePane()?.tab.cwd ?? homeDir
}

function activePane(): Pane | undefined {
  return activeId ? panes.get(activeId) : undefined
}

/* ------------------------------------------------------------ Focus */

/**
 * Keeps the keyboard in the terminal. Chromium drops the focus to `<body>`
 * whenever the focused element is hidden (the session picker closes) or a
 * mousedown lands on something that cannot take focus — a tab, the empty space
 * of the tab bar. xterm.js then draws its unfocused cursor as a hollow box and
 * every keystroke goes nowhere, so take the focus back whenever it ends up on
 * nothing.
 *
 * The check runs in a later task, because at focusout time the focus has not
 * moved yet. Preventing the default of the mousedown would be the direct fix,
 * but it would also stop the tabs from being dragged.
 */
function installFocusGuard(): void {
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (document.activeElement !== document.body) return
      // While the window is inactive the focus belongs to whatever the user
      // switched to, and overlays bring their own focus handling.
      if (!document.hasFocus()) return
      if (picker.isOpen() || searchBar.isOpen() || newTabMenu.isOpen()) return
      if (confirmDialog.isOpen() || groupDialog.isOpen() || updates.isOpen()) return
      activePane()?.view?.focus()
    })
  })
}

/* -------------------------------------------------------- Font size */

function changeFontSize(delta: number | 'reset'): void {
  fontSize =
    delta === 'reset' ? BASE_FONT_SIZE : Math.min(28, Math.max(8, fontSize + delta))
  localStorage.setItem('fontSize', String(fontSize))
  for (const pane of panes.values()) pane.view?.setFontSize(fontSize)
  // Also shown when the size was already clamped — that is the feedback that
  // the limit is reached.
  zoomIndicator.show(Math.round((fontSize / BASE_FONT_SIZE) * 100))
}

/* ------------------------------------------------------ Persistence */

function persist(): void {
  const state: PersistedState = {
    version: 1,
    tabs: order
      .map((id, index) => {
        const pane = panes.get(id)
        if (!pane) return undefined
        return { ...pane.tab, order: index }
      })
      .filter((tab): tab is TabState => Boolean(tab)),
    activeTabId: activeId,
    groups: [...groups.values()]
  }
  void api.state.save(state)
}
