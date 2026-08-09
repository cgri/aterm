export type TabKind = 'claude' | 'powershell'

/** What aterm remembers about a tab. This is what ends up in state.json. */
export interface TabState {
  id: string
  kind: TabKind
  title: string
  cwd: string
  /**
   * For kind==='claude' the agent's own session; for kind==='powershell' the
   * Claude session most recently detected in that tab (see SessionDetector).
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

/** The main process matched a Claude session started inside a shell tab to that tab. */
export interface SessionDetectedEvent {
  tabId: string
  sessionId: string
  source: 'wrapper' | 'transcript'
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
