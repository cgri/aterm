import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentActivityEvent,
  Appearance,
  ClipboardPayload,
  PersistedState,
  PtyDataEvent,
  PtyExitEvent,
  SessionDetectedEvent,
  StartSpec
} from '@shared/types'
import { IPC } from './ipc'
import { PtyManager } from './pty/PtyManager'
import { SessionStore } from './state/SessionStore'
import { HistoryReader } from './claude/HistoryReader'
import { hasConversation } from './claude/transcripts'
import { readJsonFile } from './util/json'
import { isGitRepo } from './util/git'
import { SessionDetector } from './claude/SessionDetector'
import { ProcessTree } from './proc/ProcessTree'
import { reapOrphanTabs } from './proc/orphans'

/**
 * A dev run gets its own userData directory. Otherwise it shares
 * `%APPDATA%\aterm` with the installed app — the same state.json, so it restores
 * the very tabs that are already open there and starts a second `claude` on a
 * session id that is in use. That session then dies. Set before `whenReady`,
 * because everything below reads the path once the app is up.
 */
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'aterm-dev'))
}

const history = new HistoryReader()
const processTree = new ProcessTree()
let detector: SessionDetector
let ptys: PtyManager
let store: SessionStore
let win: BrowserWindow | undefined
let agentRunning: Record<string, boolean> = {}

/** Height of the tab bar, which doubles as the title bar. Mirrors `#tabbar` in theme.css. */
const TITLE_BAR_HEIGHT = 34

/**
 * The window controls are drawn by Windows, not by CSS, so their colours have to
 * be repeated here. They mirror --bg-chrome, --fg and --bg of the two palettes in
 * theme.css and have to be changed together with them.
 */
const CHROME_COLORS: Record<Appearance, { chrome: string; symbol: string; backdrop: string }> = {
  dark: { chrome: '#191c24', symbol: '#d7dae2', backdrop: '#12141a' },
  light: { chrome: '#f2f3f5', symbol: '#1f2430', backdrop: '#ffffff' }
}

/** Kept for the next start, so the window opens in the colours it closed in. */
let appearance: Appearance = 'dark'

/**
 * Window and taskbar icon. The packaged exe carries the .ico of its own, but the
 * window itself is only given an icon here — without it a dev run shows the
 * Electron default.
 */
const ICON = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../resources/icon.png')

function createWindow(state: PersistedState): void {
  const bounds = state.window
  // Only a first guess: the renderer reports the appearance it really applied as
  // soon as it boots. Without it the window would flash in the wrong colours.
  appearance = state.appearance ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  const colors = CHROME_COLORS[appearance]

  win = new BrowserWindow({
    width: bounds?.width ?? 1100,
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: colors.backdrop,
    title: 'aterm',
    icon: ICON,
    // The tab bar is the title bar. Electron keeps drawing the native window
    // controls as an overlay on the right; the renderer learns how much room is
    // left through the `titlebar-area-*` CSS environment variables.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.chrome,
      symbolColor: colors.symbol,
      height: TITLE_BAR_HEIGHT
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (bounds?.maximized) win.maximize()

  // No application menu: its accelerators would steal keys from the terminal.
  Menu.setApplicationMenu(null)

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('closed', () => {
    win = undefined
  })
}

function windowBounds(): PersistedState['window'] {
  if (!win) return undefined
  const b = win.getNormalBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Keeps the detector and the process-tree poller in sync with the running tabs.
 * Called after every process start or exit, and on every poll.
 */
function syncTabs(): void {
  const persisted = new Map(store.current().tabs.map((tab) => [tab.id, tab]))
  detector.updateShellTabs(
    ptys.shellTabIds().map((tabId) => ({
      tabId,
      cwd: ptys.cwdOf(tabId) ?? '',
      agentRunning: Boolean(agentRunning[tabId]),
      claudeSessionId: persisted.get(tabId)?.claudeSessionId
    }))
  )
  // The conversation comes from state.json, the session the process was launched
  // with from the PtyManager. After a `/clear` those two differ, and telling them
  // apart is the whole point.
  detector.updateClaudeTabs(
    ptys.claudeTabs().map(({ tabId, cwd, sessionId }) => ({
      tabId,
      cwd,
      processSessionId: sessionId,
      conversationId: persisted.get(tabId)?.claudeSessionId
    }))
  )
  processTree.setRoots(new Map([...ptys.pids()].filter(([tabId]) => ptys.shellTabIds().includes(tabId))))
}

function registerIpc(): void {
  ptys.on('data', (e: PtyDataEvent) => send(IPC.ptyData, e))
  ptys.on('exit', (e: PtyExitEvent) => {
    send(IPC.ptyExit, e)
    syncTabs()
  })

  processTree.on('activity', (e: AgentActivityEvent) => {
    agentRunning = e.running
    send(IPC.agentActivity, e)
    syncTabs()
  })

  detector.on('detected', (e: SessionDetectedEvent) => send(IPC.sessionDetected, e))

  ipcMain.handle(IPC.ptyStart, (_e, spec: StartSpec) => {
    const result = ptys.start(spec)
    syncTabs()
    return result
  })
  ipcMain.handle(IPC.ptyKill, (_e, tabId: string) => {
    ptys.kill(tabId)
    detector.forgetTab(tabId)
    syncTabs()
  })
  ipcMain.on(IPC.ptyWrite, (_e, tabId: string, data: string) => ptys.write(tabId, data))
  ipcMain.on(IPC.ptyResize, (_e, tabId: string, cols: number, rows: number) =>
    ptys.resize(tabId, cols, rows)
  )

  ipcMain.handle(IPC.stateLoad, () => store.load())
  // Window bounds and appearance are known here, not in the renderer, so they are
  // filled in rather than taken from what the renderer sent.
  ipcMain.handle(IPC.stateSave, (_e, state: PersistedState) =>
    store.save({ ...state, window: windowBounds(), appearance })
  )

  ipcMain.on(IPC.setAppearance, (_e, next: Appearance) => {
    appearance = next
    const colors = CHROME_COLORS[next]
    if (!win || win.isDestroyed()) return
    win.setBackgroundColor(colors.backdrop)
    win.setTitleBarOverlay({ color: colors.chrome, symbolColor: colors.symbol })
  })

  ipcMain.handle(IPC.sessionsRecent, () => history.recent())
  ipcMain.handle(IPC.sessionResumable, (_e, cwd: string, sessionId: string) =>
    hasConversation(cwd, sessionId)
  )
  ipcMain.handle(IPC.newSessionId, () => randomUUID())
  ipcMain.handle(IPC.homeDir, () => homedir())
  ipcMain.handle(IPC.isGitRepo, (_e, cwd: string) => isGitRepo(cwd))

  // Optional rebinding: {"newClaudeTab": ["Ctrl+N"], "search": []}
  ipcMain.handle(IPC.keymapLoad, () => {
    const file = join(app.getPath('userData'), 'keymap.json')
    return existsSync(file) ? (readJsonFile<Record<string, string[]>>(file) ?? {}) : {}
  })

  ipcMain.handle(IPC.pickFolder, async (_e, startIn?: string) => {
    if (!win) return undefined
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose working directory',
      defaultPath: startIn,
      properties: ['openDirectory']
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  ipcMain.handle(IPC.clipboardRead, (): ClipboardPayload => {
    const image = clipboard.readImage()
    if (!image.isEmpty()) {
      const dir = join(tmpdir(), 'aterm')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `paste-${Date.now()}.png`)
      writeFileSync(file, image.toPNG())
      return { kind: 'image', path: file }
    }
    const text = clipboard.readText()
    return text ? { kind: 'text', text } : { kind: 'empty' }
  })

  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => {
    clipboard.writeText(text)
  })
}

app.whenReady().then(() => {
  // Matches `build.appId`, so the taskbar entry keeps the app's identity and icon
  // instead of Electron's.
  app.setAppUserModelId('de.aterm.app')

  // Anything a previous run left behind goes before the first tab can start. Not
  // awaited: tabs restore lazily, so the first start is a click away at the earliest.
  reapOrphanTabs()

  const userData = app.getPath('userData')
  store = new SessionStore(userData)
  detector = new SessionDetector(userData)
  ptys = new PtyManager(detector.dir())
  detector.start()

  const state = store.load()
  registerIpc()
  createWindow(state)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store.current())
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  store?.save({ ...store.current(), window: windowBounds(), appearance })
  store?.flush()
  history.dispose()
  detector?.stop()
  processTree.stop()
  ptys?.killAll()
})
