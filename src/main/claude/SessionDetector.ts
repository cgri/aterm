import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { basename, join } from 'node:path'
import type { SessionDetectedEvent } from '@shared/types'
import { readJsonFile } from '../util/json'
import { projectsDir } from './paths'
import { firstUserEntry, transcriptOrigin, transcriptTail } from './transcripts'

/** What the detector needs to know about a running shell tab. */
export interface ShellTabInfo {
  tabId: string
  cwd: string
  agentRunning: boolean
  claudeSessionId?: string
}

/** What the detector needs to know about a running Claude tab. */
export interface ClaudeTabInfo {
  tabId: string
  cwd: string
  /** The session the process was launched with — it never changes while it runs. */
  processSessionId: string
  /** The conversation the tab is currently believed to be in. */
  conversationId?: string
}

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** A file being written to fires a change event per line; once every two seconds is plenty. */
const RECHECK_MS = 2000

/**
 * Works out which Claude conversation a tab is in.
 *
 * Level 1 — a session started inside a PowerShell tab: the startup profile reports
 * the UUID it assigned through a file in runtime/. Deterministic, and takes effect
 * immediately.
 * Level 2 — the same, from the transcript: new files under ~/.claude/projects are
 * watched; the first user line names sessionId and cwd. This also works when the
 * wrapper was bypassed. When several candidates match equally well, nothing is
 * guessed.
 * Level 3 — a Claude tab whose conversation moved on under it (see `inspectSwitch`).
 */
export class SessionDetector extends EventEmitter {
  private readonly runtimeDir: string
  private runtimeWatcher?: FSWatcher
  private transcriptWatcher?: FSWatcher
  private knownTranscripts = new Set<string>()
  private shellTabs: ShellTabInfo[] = []
  private claudeTabs: ClaudeTabInfo[] = []
  private lastSwitchCheck = new Map<string, number>()
  private startedAt = Date.now()

  constructor(userDataDir: string) {
    super()
    this.runtimeDir = join(userDataDir, 'runtime')
    mkdirSync(this.runtimeDir, { recursive: true })
  }

  dir(): string {
    return this.runtimeDir
  }

  start(): void {
    this.startedAt = Date.now()
    this.seedTranscripts()
    this.watchRuntime()
    this.watchTranscripts()
  }

  stop(): void {
    this.runtimeWatcher?.close()
    this.transcriptWatcher?.close()
    this.runtimeWatcher = undefined
    this.transcriptWatcher = undefined
  }

  /** The main process reports the current picture after every tab change. */
  updateShellTabs(tabs: ShellTabInfo[]): void {
    this.shellTabs = tabs
  }

  updateClaudeTabs(tabs: ClaudeTabInfo[]): void {
    this.claudeTabs = tabs
  }

  /** Clean up when a tab goes away. */
  forgetTab(tabId: string): void {
    const file = join(this.runtimeDir, `${tabId}.json`)
    try {
      rmSync(file, { force: true })
    } catch {
      // does not matter
    }
  }

  // ------------------------------------------------------------ Level 1

  private watchRuntime(): void {
    try {
      this.runtimeWatcher = watch(this.runtimeDir, (_event, filename) => {
        if (filename) this.readRuntimeReport(String(filename))
      })
    } catch {
      // Without a watcher, level 2 still applies.
    }
  }

  private readRuntimeReport(filename: string): void {
    if (!filename.endsWith('.json')) return
    const file = join(this.runtimeDir, filename)
    if (!existsSync(file)) return

    // If anything is missing the file is half-written — the next event brings it whole.
    const report = readJsonFile<{ tabId?: string; sessionId?: string }>(file)
    if (!report?.tabId || !report.sessionId) return

    this.emitDetected({ tabId: report.tabId, sessionId: report.sessionId, source: 'wrapper' })
  }

  // ------------------------------------------------------------ Level 2

  /** Anything that already existed at startup is not a new arrival. */
  private seedTranscripts(): void {
    const root = projectsDir()
    if (!existsSync(root)) return
    for (const project of safeReaddir(root)) {
      for (const file of safeReaddir(join(root, project))) {
        if (UUID_JSONL.test(file)) this.knownTranscripts.add(join(project, file))
      }
    }
  }

  private watchTranscripts(): void {
    const root = projectsDir()
    if (!existsSync(root)) return
    try {
      this.transcriptWatcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = String(filename)
        if (!UUID_JSONL.test(basename(rel))) return
        const fresh = !this.knownTranscripts.has(rel)
        if (fresh) {
          this.knownTranscripts.add(rel)
          // The first user line only appears with the first prompt.
          setTimeout(() => this.inspectTranscript(join(root, rel)), 400)
        }
        this.inspectSwitch(rel, fresh)
      })
    } catch {
      // Without a watcher, level 1 still applies.
    }
  }

  private inspectTranscript(file: string, attempt = 0): void {
    if (!existsSync(file)) return

    // Only files created after the app started are candidates.
    try {
      if (statSync(file).birthtimeMs < this.startedAt - 60_000) return
    } catch {
      return
    }

    const head = firstUserEntry(file)
    if (!head) {
      if (attempt < 20) setTimeout(() => this.inspectTranscript(file, attempt + 1), 1500)
      return
    }

    const candidates = this.shellTabs.filter(
      (tab) => tab.agentRunning && !tab.claudeSessionId
    )
    const byCwd = candidates.filter((tab) => samePath(tab.cwd, head.cwd))

    // Unambiguous by path, otherwise the only tab with a running agent.
    const target =
      byCwd.length === 1 ? byCwd[0] : byCwd.length === 0 && candidates.length === 1 ? candidates[0] : undefined
    if (!target) return

    this.emitDetected({
      tabId: target.tabId,
      sessionId: head.sessionId,
      source: 'transcript'
    })
  }

  // ------------------------------------------------------------ Level 3

  /**
   * A running Claude tab whose conversation moved on. `/clear` opens a new
   * transcript, `/resume` continues an existing one, and in both cases the process
   * keeps the `session_id` it was launched with — that is what makes the match
   * unambiguous, even with several tabs in the same directory. Without this the tab
   * would keep resuming the state from before the switch, which is exactly how a
   * restart used to lose an afternoon of work.
   *
   * Which id a file names is not guessed from its size or age: a file that has just
   * appeared is read from the front (the session that forked it off), an existing one
   * from the back (the session writing into it now).
   */
  private inspectSwitch(rel: string, fresh: boolean, attempt = 0): void {
    if (this.claudeTabs.length === 0) return

    const conversation = basename(rel, '.jsonl')
    // The file a tab is known to be in needs no second look — the common case, and
    // it fires an event per written line.
    if (this.claudeTabs.some((tab) => tab.conversationId === conversation)) return

    if (!fresh) {
      const last = this.lastSwitchCheck.get(rel) ?? 0
      if (Date.now() - last < RECHECK_MS) return
      this.lastSwitchCheck.set(rel, Date.now())
    }

    const file = join(projectsDir(), rel)
    if (!existsSync(file)) return

    // Right after `/clear` the file holds a few lines that name no session_id yet.
    const origin = fresh ? transcriptOrigin(file) : transcriptTail(file)
    if (!origin) {
      if (fresh && attempt < 20) {
        setTimeout(() => this.inspectSwitch(rel, true, attempt + 1), 1500)
      }
      return
    }
    if (origin.sessionId !== conversation) return

    const target = this.claudeTabs.find(
      (tab) => tab.processSessionId === origin.processSessionId
    )
    if (!target || target.conversationId === origin.sessionId) return

    target.conversationId = origin.sessionId
    this.emit('detected', {
      tabId: target.tabId,
      sessionId: origin.sessionId,
      source: 'switch'
    } satisfies SessionDetectedEvent)
  }

  private emitDetected(event: SessionDetectedEvent): void {
    const tab = this.shellTabs.find((t) => t.tabId === event.tabId)
    if (tab) tab.claudeSessionId = event.sessionId
    this.emit('detected', event)
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}
