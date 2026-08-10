export type TabKind = 'claude' | 'powershell'

/** What the user picked; 'system' follows the Windows setting. */
export type ThemeMode = 'system' | 'light' | 'dark'

/** What 'system' resolves to — the palette actually in use. */
export type Appearance = 'light' | 'dark'

/** What aterm remembers about a tab. This is what ends up in state.json. */
export interface TabState {
  id: string
  kind: TabKind
  /**
   * What the session is about — its first prompt, once there is one. The tab is
   * named after its directory, so this is only the part behind that; a tab
   * without a summary is named by the folder alone.
   */
  summary?: string
  cwd: string
  /**
   * The Claude conversation this tab was last in — what a restart resumes. For
   * kind==='claude' that is the id aterm assigned only until the session moves on
   * (`/clear`, `/resume`); from then on it is the conversation's id, not the one the
   * process was started with. For kind==='powershell' it is the session most
   * recently detected in that tab. Both are kept up to date by SessionDetector.
   */
  claudeSessionId?: string
  /** Whether a resumable conversation exists — decided from the transcript. */
  everStarted: boolean
  order: number
}

export type TabRunState =
  /** No process — freshly restored tab, waiting to be activated. */
  | { status: 'stopped' }
  | { status: 'running'; agentRunning: boolean }
  | { status: 'exited'; exitCode: number }

export interface PersistedState {
  version: number
  window?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }
  tabs: TabState[]
  activeTabId?: string
  /**
   * Last resolved appearance, written by the main process. It only exists so the
   * next window can be created in the right colours — the mode itself belongs to
   * the renderer, which applies it before anything is drawn.
   */
  appearance?: Appearance
}

export interface RecentSession {
  sessionId: string
  cwd: string
  title: string
  lastUsed: number
  promptCount: number
}

export interface PtyDataEvent {
  tabId: string
  data: string
}

export interface PtyExitEvent {
  tabId: string
  exitCode: number
}

/**
 * The main process worked out which Claude conversation a tab is in: one started
 * inside a shell tab ('wrapper', 'transcript'), or one a running Claude tab moved
 * to by itself ('switch' — `/clear` and `/resume` leave the old id behind).
 */
export interface SessionDetectedEvent {
  tabId: string
  sessionId: string
  source: 'wrapper' | 'transcript' | 'switch'
}

export interface AgentActivityEvent {
  /** tabId → is a claude.exe descendant running in that tab right now? */
  running: Record<string, boolean>
}

export type ClipboardPayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'empty' }

export interface StartSpec {
  tabId: string
  kind: TabKind
  cwd: string
  /** The session id to use (freshly generated or restored). */
  claudeSessionId?: string
  /** true → --resume instead of --session-id */
  resume: boolean
  /**
   * true → ask Claude Code for a fresh git worktree (`--worktree`). Only ever
   * honoured on a first start; resuming a session must not branch off again.
   */
  worktree?: boolean
  cols: number
  rows: number
}

export interface StartResult {
  ok: boolean
  /** The session id actually used (may differ from the requested one). */
  claudeSessionId?: string
  /** Was --resume used? The main process makes that call. */
  resumed?: boolean
  error?: string
}
