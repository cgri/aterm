import '@xterm/xterm/css/xterm.css'
import './theme.css'
import type { PersistedState, RecentSession, TabKind, TabState } from '@shared/types'
import { TabBar, type TabViewModel } from './TabBar'
import { TerminalView } from './TerminalView'
import { SessionPicker } from './SessionPicker'
import { NewTabMenu, type MenuItem } from './NewTabMenu'
import { buildBindings, installKeymap, installWheelZoom, type Action } from './keymap'
import { SearchBar } from './SearchBar'
import { ZoomIndicator } from './ZoomIndicator'
import { ConfirmDialog } from './ConfirmDialog'
import { ThemeToggle } from './ThemeToggle'
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
}

/** Claude Code says what it is up to in front of its window title. */
type PtyState = 'working' | 'awaiting'

const api = window.aterm
const barRoot = document.getElementById('tabbar') as HTMLElement
const paneRoot = document.getElementById('panes') as HTMLElement

const panes = new Map<string, Pane>()
let order: string[] = []
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

const tabBar = new TabBar(
  barRoot,
  {
    onSelect: (id) => activate(id, { start: true }),
    onClose: (id) => void closeTab(id),
    onNew: () => void openNewTabMenu(),
    onReorder: (dragged, before) => reorder(dragged, before)
  },
  [themeToggle.element]
)

onThemeChange(() => {
  for (const pane of panes.values()) pane.view?.setAppearance(currentAppearance())
})

const newTabMenu = new NewTabMenu(() => activePane()?.view?.focus())
const confirmDialog = new ConfirmDialog(() => activePane()?.view?.focus())
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
      cycleTab: (delta) => cycleTab(delta),
      selectTabByIndex: (index) => {
        const id = order[index]
        if (id) activate(id, { start: true })
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
        picker.isOpen() || searchBar.isOpen() || newTabMenu.isOpen() || confirmDialog.isOpen()
    },
    buildBindings(overrides)
  )
  installWheelZoom((delta) => changeFontSize(delta))
  installFocusGuard()
  installAttentionTracking()

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
  activate(state.activeTabId ?? order[0], { start: false })
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
    awaitingSeen: false
  }
  panes.set(tab.id, pane)
  if (!order.includes(tab.id)) order.push(tab.id)
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

  if (activeId === id) activeId = order[Math.max(0, order.length - 1)]
  if (order.length === 0) {
    await createTab('powershell', homeDir)
    return
  }
  activate(activeId, { start: false })
  render()
  persist()
}

function activate(id: string | undefined, opts: { start: boolean }): void {
  if (!id || !panes.has(id)) return
  activeId = id

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
  if (order.length < 2 || !activeId) return
  const index = order.indexOf(activeId)
  const next = (index + delta + order.length) % order.length
  activate(order[next], { start: true })
}

function reorder(draggedId: string, beforeId: string | undefined): void {
  const from = order.indexOf(draggedId)
  if (from < 0) return
  order.splice(from, 1)
  const to = beforeId ? order.indexOf(beforeId) : order.length
  order.splice(to < 0 ? order.length : to, 0, draggedId)
  order.forEach((id, index) => {
    const pane = panes.get(id)
    if (pane) pane.tab.order = index
  })
  render()
  persist()
}

/* ------------------------------------------------------ Process start */

async function startPane(pane: Pane): Promise<void> {
  const { tab } = pane

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
  const models: TabViewModel[] = order
    .map((id) => panes.get(id))
    .filter((pane): pane is Pane => Boolean(pane))
    .map((pane) => ({
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
    }))
  tabBar.render(models, activeId)

  for (const pane of panes.values()) updatePlaceholder(pane)
  const active = activePane()
  document.title = active ? `${paneTitle(active)} — aterm` : 'aterm'
  updateAttention()
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
  if (!label) return { state: marker?.state }
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
      if (confirmDialog.isOpen()) return
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
    activeTabId: activeId
  }
  void api.state.save(state)
}
