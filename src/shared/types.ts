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
  /** The group this tab belongs to, if any. Absent is the normal case. */
  groupId?: string
  /**
   * The tab whose Claude session opened this one through aterm's `open_tab` tool. Only
   * that tab may close it again, and a tab opened that way opens no tabs of its own.
   */
  openedBy?: string
  order: number
}

/**
 * A group's colour, as a name rather than a value: it is persisted, and it has to
 * work in both palettes, which only `theme.css` knows. A colour it does not know
 * falls back to 'grey' while loading, so a ninth colour added later can still be
 * opened by an older aterm.
 */
export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan'
] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

/** A named, coloured run of neighbouring tabs. */
export interface TabGroup {
  id: string
  /** Absent = nameless: the header is the colour swatch alone. */
  name?: string
  color: TabGroupColor
  collapsed: boolean
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
   * The tab groups, in no particular order — where a group sits on screen follows
   * from its members' `order`, not from this list.
   *
   * Adding this did not raise `SCHEMA_VERSION`, and neither should the next
   * additive field: `SessionStore.load` sets a state.json aside whose version is
   * *newer* than its own, so a bump costs every tab of anyone who goes back to an
   * older aterm — for a field that older aterm would simply have ignored.
   */
  groups?: TabGroup[]
  /**
   * Last resolved appearance, written by the main process. It only exists so the
   * next window can be created in the right colours — the mode itself belongs to
   * the renderer, which applies it before anything is drawn.
   */
  appearance?: Appearance
  /**
   * The tabs that were running when aterm quit to install an update, written by the main
   * process. The version that installer brings is part of it: only that version starts
   * them again, so an installer that failed does not turn the next ordinary start into
   * one that resumes everything. Gone with the renderer's first save after that start.
   */
  resumeAfterUpdate?: { version: string; tabIds: string[] }
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
  /**
   * aterm ended this process — the tab was closed, restarted, or the app is quitting —
   * rather than the program finishing on its own. A killed process can report exit code
   * 0 as well, so the code alone says nothing about who ended it.
   */
  killed: boolean
}

/**
 * The main process worked out which Claude conversation a tab is in: one started
 * inside a shell tab ('wrapper', 'transcript'), or one a running Claude tab moved
 * to by itself when the user ran `/clear` or `/resume`, which leave the old id
 * behind — read from the transcript ('switch') or from Claude Code's own registry
 * of running sessions ('registry', which knows it first).
 */
export interface SessionDetectedEvent {
  tabId: string
  sessionId: string
  source: 'wrapper' | 'transcript' | 'switch' | 'registry'
}

/**
 * What Claude Code's registry says a Claude tab's session is doing. `busy` also covers
 * a finished turn while background agents or workflows still run; background shells
 * and scheduled wakeups do not count, so the session reads `idle` then.
 */
export type SessionStatus = 'busy' | 'idle' | 'waiting'

export interface SessionStatusEvent {
  tabId: string
  status: SessionStatus
}

/** An image a tab's conversation has seen, found in its transcript. */
export interface TranscriptImage {
  id: string
  /** `aterm-image://img/<id>` — served by the main process from the transcript. */
  url: string
  /** The file a tool read it from, the tool's name, or "Pasted image". */
  label: string
  source: 'user' | 'tool'
  /** Whether a file was named that `images:open` can hand to the default viewer. */
  hasFile: boolean
  width?: number
  height?: number
}

/** `reset`: the tab follows a conversation anew, and `images` replaces what it had. */
export interface TabImagesEvent {
  tabId: string
  reset: boolean
  images: TranscriptImage[]
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
  /** The first prompt of a new session. Never used for a resume. */
  initialPrompt?: string
  /** The display name of a new session (`--name`). Never used for a resume. */
  sessionName?: string
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

/**
 * How this copy of aterm was delivered, which decides what an update can do: only
 * the NSIS install can replace itself. The portable exe and a dev run are pointed
 * at the release page instead.
 */
export type InstallMode = 'installer' | 'portable' | 'dev'

/** A published GitHub release newer than the running version. */
export interface ReleaseInfo {
  /** Without the tag's `v`: `1.9.0`. */
  version: string
  title: string
  /** The release notes as written on GitHub, Markdown. */
  notes: string
  /** The release page. */
  url: string
  publishedAt: string
}

export interface UpdateCheck {
  /** The version the check compared against. */
  current: string
  mode: InstallMode
  /** Newest first. Empty when aterm is up to date. */
  releases: ReleaseInfo[]
}

export interface UpdateProgress {
  received: number
  total: number
}

export interface UpdateResult {
  ok: boolean
  error?: string
}

/**
 * A plan Claude Code wants approved, caught by aterm's `ExitPlanMode` hook. The hook
 * process waits until the review is answered, so every request gets exactly one answer.
 */
export interface PlanReviewRequest {
  reviewId: string
  tabId: string
  /** The plan as Claude Code wrote it: Markdown. */
  plan: string
}

/**
 * The permission mode an approved plan is carried out in — the first two choices of
 * Claude Code's own "Would you like to proceed?" menu. `default` asks before each edit.
 */
export type PlanStartMode = 'auto' | 'default'

/**
 * `approve` lets the plan through in `mode`, with the user's comments appended to the
 * plan as `notes`; `revise` sends it back with them; `pass` gives no decision at all,
 * so Claude Code asks in the terminal as usual.
 */
export type PlanReviewAnswer =
  | { kind: 'approve'; mode: PlanStartMode; notes?: string }
  | { kind: 'revise'; feedback: string }
  | { kind: 'pass' }

/**
 * A text a Claude session means to post somewhere on the user's behalf, held by aterm's
 * `review_text` tool until the user decides in the tab's review panel.
 */
export interface TextReviewRequest {
  reviewId: string
  tabId: string
  /** What the text is, e.g. "PR description". */
  title: string
  /** Where it is going, e.g. "GitHub cgri/aterm#66". */
  target: string
  /** Markdown. */
  text: string
}

/**
 * `approve` hands back the text to post, word for word — the user's own edit of it, if
 * `edited`. `revise` sends comments back for another round; `reject` means it is not to
 * be posted at all; `pass` is no decision, and Claude asks in the terminal.
 */
export type TextReviewAnswer =
  | { kind: 'approve'; text: string; edited: boolean }
  | { kind: 'revise'; feedback: string }
  | { kind: 'reject'; reason?: string }
  | { kind: 'pass' }

/**
 * A Claude session asks for a tab of its own through aterm's `open_tab` tool. The main
 * process has settled the directory, the isolation and the prompt; the renderer makes
 * the tab, or refuses it, and answers exactly once.
 */
export interface TabOpenRequest {
  requestId: string
  /** The tab whose session called the tool. */
  parentTabId: string
  cwd: string
  prompt: string
  worktree: boolean
  /** Names the tab and the session, already safe for a command line. */
  title: string
}

/** The renderer's answer to a `TabOpenRequest`, or to closing a tab it opened. */
export type TabRequestAnswer =
  | { ok: true; tabId: string; claudeSessionId?: string }
  | { ok: false; error: string }

export interface TabCloseRequest {
  requestId: string
  parentTabId: string
  tabId: string
}

/**
 * A tab as the renderer sees it, reported to main for the aterm MCP server's `tab_status`
 * and `wait_for_idle`. Only the renderer knows it: working and waiting are read off the
 * title and Claude Code's registry there, with the same `isWorking` and `isWaiting` the tab
 * bar draws with.
 */
export interface TabStatusReport {
  tabId: string
  /** The tab's whole name, `<folder> - <summary>`. */
  name: string
  /** An agent tab (✳) or a shell (❯), as the tab bar tells them apart. */
  agent: boolean
  /**
   * `working` breathes, `waiting` waits for the user, `idle` runs and does neither;
   * `stopped` has not started (a restored placeholder), `exited` has ended.
   */
  state: 'working' | 'waiting' | 'idle' | 'stopped' | 'exited'
  /** Waiting and not looked at yet — the red dot. */
  unseen: boolean
}
/* ------------------------------------------------------------------ Tasks */

/**
 * Something the user has to do for a task: answer a question a session asked, or review
 * and merge a PR/MR (or approve some other piece of work). Declared by a session through
 * `task_update`. A question is settled by the answer — the tab that asked goes back to
 * work — while a review outlives every session: it waits, often for days, until the user
 * or a session marks it done.
 */
export interface TaskAsk {
  id: string
  kind: 'question' | 'review'
  /** One sentence: what is asked, or what is to be reviewed. */
  text: string
  /** The PR/MR, ticket or page the ask is about. */
  url?: string
  /** The tab whose session asked. */
  tabId?: string
  /** The name of the session that asked, for "asked by". */
  by?: string
  at: number
}

/**
 * A session working on a task. Bound to the tab rather than to a conversation id, so
 * `/clear` and `/resume` keep it on the task; the conversation is remembered for when the
 * tab is gone, so it can be resumed from the task.
 */
export interface TaskSession {
  tabId: string
  claudeSessionId?: string
  cwd: string
  name?: string
  /** The tab was closed. Kept so the conversation can be resumed from the task. */
  closed?: boolean
  joinedAt: number
}

export interface TaskEvent {
  at: number
  kind: 'created' | 'working' | 'needs_user' | 'blocked' | 'done' | 'reopened' | 'joined' | 'left' | 'resolved'
  text: string
  by?: string
}

/**
 * An entry in aterm's task list: a short-lived to-do nobody files a ticket for, or the
 * work on a ticket or issue. Owned by the main process and kept in `userData/tasks.json`,
 * apart from `state.json`, because a task outlives every tab that worked on it.
 *
 * Only what aterm cannot see for itself is stored: blocked, the asks, done, the last note.
 * Whether a task is being worked on, or a session on it waits for an answer, the renderer
 * reads off the tabs — see `taskState` in `TaskPanel.ts`.
 */
export interface Task {
  /** Internal and stable; what the renderer and main refer to a task by. */
  id: string
  /**
   * What the user and Claude call it: `T7` (`taskRef`). Handed out in order of creation
   * and never reused, so it is short enough to say and type, and reads as a task's and
   * not as a GitHub number.
   */
  number: number
  title: string
  /** A ticket key, an issue/PR/MR link, or anything else the task came from. */
  source?: string
  notes?: string
  /** Where a session started on this task runs. */
  cwd?: string
  /** Why the task is blocked, while it is. Always declared, never derived. */
  blocked?: string
  asks: TaskAsk[]
  sessions: TaskSession[]
  /** The last sentence a session reported, shown under the title. */
  note?: { text: string; by?: string; at: number }
  doneAt?: number
  createdAt: number
  updatedAt: number
  /** Newest last, capped. */
  activity: TaskEvent[]
}

/** What the renderer can do to the tasks. Main applies it and sends the new list. */
export type TaskAction =
  | { kind: 'create'; title: string; source?: string; notes?: string; cwd?: string }
  | { kind: 'edit'; taskId: string; title?: string; source?: string; notes?: string; cwd?: string }
  | { kind: 'setDone'; taskId: string; done: boolean }
  | { kind: 'setBlocked'; taskId: string; reason?: string }
  | { kind: 'resolveAsk'; taskId: string; askId: string }
  | { kind: 'join'; taskId: string; session: TaskSessionInfo }
  | { kind: 'leave'; taskId: string; tabId: string }
  /** The tab is gone; its session stays on the task, to be resumed. */
  | { kind: 'tabClosed'; session: TaskSessionInfo }
  /** A tab that was waiting went back to work: whatever it asked has been answered. */
  | { kind: 'answered'; tabId: string }
  | { kind: 'delete'; taskId: string }

export interface TaskSessionInfo {
  tabId: string
  claudeSessionId?: string
  cwd: string
  name?: string
}

export type TaskActionResult = { ok: true; taskId?: string } | { ok: false; error: string }
