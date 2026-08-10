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
import { projectsDir, sessionsDir } from './paths'
import {
  listLiveSessions,
  pidOfRegistryFile,
  readLiveSession,
  type LiveSession
} from './sessionRegistry'
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
  /** The pty's own process — `claude.exe` itself, unless it had to go through cmd. */
  pid: number
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
 * Level 4 — the same question answered by Claude Code's own session registry, which
 * knows it before a transcript can tell (see `applyLiveSession`).
 */
export class SessionDetector extends EventEmitter {
  private readonly runtimeDir: string
  private runtimeWatcher?: FSWatcher
  private transcriptWatcher?: FSWatcher
  private registryWatcher?: FSWatcher
  private knownTranscripts = new Set<string>()
  private shellTabs: ShellTabInfo[] = []
  private claudeTabs: ClaudeTabInfo[] = []
  private lastSwitchCheck = new Map<string, number>()
  /** tabId → the `claude` pid that answers for it, and the pty it was learned from. */
  private registryPids = new Map<string, { ptyPid: number; claudePid: number }>()
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
    this.watchRegistry()
  }

  stop(): void {
    this.runtimeWatcher?.close()
    this.transcriptWatcher?.close()
    this.registryWatcher?.close()
    this.runtimeWatcher = undefined
    this.transcriptWatcher = undefined
    this.registryWatcher = undefined
  }

  /** The main process reports the current picture after every tab change. */
  updateShellTabs(tabs: ShellTabInfo[]): void {
    this.shellTabs = tabs
  }

  updateClaudeTabs(tabs: ClaudeTabInfo[]): void {
    this.claudeTabs = tabs
    // A learned pid only answers for the process it was learned from. Windows hands
    // pids out again, so a tab that has been restarted has to learn its own anew.
    for (const [tabId, record] of this.registryPids) {
      const tab = tabs.find((t) => t.tabId === tabId)
      if (!tab || tab.pid !== record.ptyPid) this.registryPids.delete(tabId)
    }
    this.sweepRegistry()
  }

  /** Clean up when a tab goes away. */
  forgetTab(tabId: string): void {
    this.registryPids.delete(tabId)
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

  // ------------------------------------------------------------ Level 4

  private watchRegistry(): void {
    const dir = sessionsDir()
    if (!existsSync(dir)) return
    try {
      this.registryWatcher = watch(dir, (_event, filename) => {
        if (!filename) return
        const pid = pidOfRegistryFile(String(filename))
        if (pid === undefined) return
        const entry = readLiveSession(pid)
        if (entry) this.applyLiveSession(entry)
      })
    } catch {
      // Without a watcher, level 3 still applies once the model has answered.
    }
  }

  /**
   * Reads the whole registry — for tabs whose process has not been identified yet.
   * Cheap, and it stops happening as soon as every Claude tab knows its pid: the
   * watcher only reports *changes*, so a tab started before the file appeared would
   * otherwise wait for the next one.
   */
  private sweepRegistry(): void {
    if (this.claudeTabs.every((tab) => this.registryPids.has(tab.tabId))) return
    // The directory only exists once Claude Code has run at least once, which on a
    // fresh machine may be after aterm started.
    if (!this.registryWatcher) this.watchRegistry()
    for (const entry of listLiveSessions()) this.applyLiveSession(entry)
  }

  /**
   * A Claude tab whose conversation moved on, answered by Claude Code itself. Level 3
   * has to wait for a transcript line that names both ids, and `session_id` first
   * appears on the first *assistant* line — so a `/clear` that is never followed by a
   * reply stays invisible there, and the tab would resume the conversation from before
   * it. The registry names the conversation the moment it changes.
   */
  private applyLiveSession(entry: LiveSession): void {
    const target = this.claudeTabFor(entry)
    if (!target) return

    this.registryPids.set(target.tabId, { ptyPid: target.pid, claudePid: entry.pid })
    if (target.conversationId === entry.sessionId) return

    target.conversationId = entry.sessionId
    this.emit('detected', {
      tabId: target.tabId,
      sessionId: entry.sessionId,
      source: 'registry'
    } satisfies SessionDetectedEvent)
  }

  /**
   * Which tab a registered session belongs to. Never by cwd — a `--worktree` tab runs
   * in the worktree, not in the directory the tab was started in.
   */
  private claudeTabFor(entry: LiveSession): ClaudeTabInfo | undefined {
    // The pty's own child: the normal case, where `claude.exe` was started directly.
    const direct = this.claudeTabs.find((tab) => tab.pid === entry.pid)
    if (direct) return direct

    // Learned before, and it keeps answering after the conversation has moved on.
    const learned = this.claudeTabs.find(
      (tab) => this.registryPids.get(tab.tabId)?.claudePid === entry.pid
    )
    if (learned) return learned

    // Still in the session it was launched with — which is how a pid gets learned in
    // the first place. This is the route for a `claude` reached through cmd.exe, whose
    // pid the pty never sees.
    return this.claudeTabs.find((tab) => tab.processSessionId === entry.sessionId)
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
