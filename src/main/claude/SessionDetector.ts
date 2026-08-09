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
import { firstUserEntry } from './transcripts'

/** What the detector needs to know about a running shell tab. */
export interface ShellTabInfo {
  tabId: string
  cwd: string
  agentRunning: boolean
  claudeSessionId?: string
}

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/**
 * Works out which Claude session was started inside a PowerShell tab.
 *
 * Level 1 — the startup profile reports the UUID it assigned through a file in
 * runtime/. Deterministic, and takes effect immediately.
 * Level 2 — new transcripts under ~/.claude/projects are watched; the first user
 * line names sessionId and cwd. This also works when the wrapper was bypassed.
 * When several candidates match equally well, nothing is guessed.
 */
export class SessionDetector extends EventEmitter {
  private readonly runtimeDir: string
  private runtimeWatcher?: FSWatcher
  private transcriptWatcher?: FSWatcher
  private knownTranscripts = new Set<string>()
  private shellTabs: ShellTabInfo[] = []
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
        if (this.knownTranscripts.has(rel)) return
        this.knownTranscripts.add(rel)
        // The first user line only appears with the first prompt.
        setTimeout(() => this.inspectTranscript(join(root, rel)), 400)
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
