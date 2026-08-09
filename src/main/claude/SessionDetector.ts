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

/** Was der Detector über einen laufenden Shell-Tab wissen muss. */
export interface ShellTabInfo {
  tabId: string
  cwd: string
  agentRunning: boolean
  claudeSessionId?: string
}

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/**
 * Findet heraus, welche Claude-Session in einem PowerShell-Tab gestartet wurde.
 *
 * Ebene 1 — das Startprofil meldet die von ihm vergebene UUID über eine Datei
 * in runtime/. Deterministisch, greift sofort.
 * Ebene 2 — neue Transkripte unter ~/.claude/projects werden beobachtet; ihre
 * erste Nutzer-Zeile nennt sessionId und cwd. Greift auch, wenn der Wrapper
 * umgangen wurde. Bei mehreren gleich guten Kandidaten wird nicht geraten.
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

  /** Der Main-Prozess meldet nach jedem Tab-Wechsel den aktuellen Stand. */
  updateShellTabs(tabs: ShellTabInfo[]): void {
    this.shellTabs = tabs
  }

  /** Aufräumen, wenn ein Tab verschwindet. */
  forgetTab(tabId: string): void {
    const file = join(this.runtimeDir, `${tabId}.json`)
    try {
      rmSync(file, { force: true })
    } catch {
      // egal
    }
  }

  // ------------------------------------------------------------ Ebene 1

  private watchRuntime(): void {
    try {
      this.runtimeWatcher = watch(this.runtimeDir, (_event, filename) => {
        if (filename) this.readRuntimeReport(String(filename))
      })
    } catch {
      // Ohne Watcher bleibt Ebene 2.
    }
  }

  private readRuntimeReport(filename: string): void {
    if (!filename.endsWith('.json')) return
    const file = join(this.runtimeDir, filename)
    if (!existsSync(file)) return

    // Fehlt etwas, ist die Datei halb geschrieben — das nächste Event bringt sie vollständig.
    const report = readJsonFile<{ tabId?: string; sessionId?: string }>(file)
    if (!report?.tabId || !report.sessionId) return

    this.emitDetected({ tabId: report.tabId, sessionId: report.sessionId, source: 'wrapper' })
  }

  // ------------------------------------------------------------ Ebene 2

  /** Alles, was es beim Start schon gab, ist für uns kein Neuzugang. */
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
        // Die erste Nutzer-Zeile erscheint erst mit dem ersten Prompt.
        setTimeout(() => this.inspectTranscript(join(root, rel)), 400)
      })
    } catch {
      // Ohne Watcher bleibt Ebene 1.
    }
  }

  private inspectTranscript(file: string, attempt = 0): void {
    if (!existsSync(file)) return

    // Nur Dateien, die nach dem App-Start entstanden sind, kommen infrage.
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

    // Eindeutig über den Pfad, sonst der einzige Tab mit laufendem Agenten.
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

