export type TabKind = 'claude' | 'powershell'

/** Was aterm dauerhaft über einen Tab weiß. Landet so in state.json. */
export interface TabState {
  id: string
  kind: TabKind
  title: string
  cwd: string
  /**
   * Bei kind==='claude' die Session des Agenten selbst, bei kind==='powershell'
   * die zuletzt in diesem Tab erkannte Claude-Session (siehe SessionDetector).
   */
  claudeSessionId?: string
  /** Steuert --session-id (erster Start) vs. --resume (jeder weitere). */
  everStarted: boolean
  order: number
}

export type TabRunState =
  /** Kein Prozess — frisch wiederhergestellter Tab, wartet auf Aktivierung. */
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

/** Der Main-Prozess hat einer Session eine im Shell-Tab gestartete Claude-Session zugeordnet. */
export interface SessionDetectedEvent {
  tabId: string
  sessionId: string
  source: 'wrapper' | 'transcript'
}

export interface AgentActivityEvent {
  /** tabId → läuft in diesem Tab gerade ein claude.exe-Nachfahre? */
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
  /** Vorgegebene Session-ID (neu erzeugt oder wiederhergestellt). */
  claudeSessionId?: string
  /** true → --resume statt --session-id */
  resume: boolean
  cols: number
  rows: number
}

export interface StartResult {
  ok: boolean
  /** Tatsächlich verwendete Session-ID (kann vom Wunsch abweichen). */
  claudeSessionId?: string
  /** Wurde --resume genutzt? Entschieden wird das im Main-Prozess. */
  resumed?: boolean
  error?: string
}
