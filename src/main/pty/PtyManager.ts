import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { StartSpec, StartResult } from '@shared/types'
import { hasConversation } from '../claude/transcripts'
import { claudeLaunch, powershellLaunch } from './launchers'

interface Running {
  proc: pty.IPty
  pid: number
  cwd: string
  kind: StartSpec['kind']
}

/**
 * Hält je Tab höchstens einen PTY-Prozess. Tabs ohne Eintrag sind reine
 * Datensätze (lazy Restore) — das ist der Normalfall direkt nach dem Start.
 */
export class PtyManager extends EventEmitter {
  private running = new Map<string, Running>()

  constructor(private readonly runtimeDir: string) {
    super()
  }

  start(spec: StartSpec): StartResult {
    this.kill(spec.tabId)

    const cwd = existsSync(spec.cwd) ? spec.cwd : homedir()

    // Fortsetzen nur, wenn es wirklich ein Gespräch gibt — sonst scheitert
    // `--resume` mit „No conversation found with session ID". Der Wunsch des
    // Renderers ist dafür nicht maßgeblich, die Ablage von Claude Code ist es.
    const resume =
      spec.kind === 'claude' &&
      Boolean(spec.claudeSessionId) &&
      hasConversation(cwd, spec.claudeSessionId!)

    let launch
    try {
      launch =
        spec.kind === 'claude'
          ? claudeLaunch({
              tabId: spec.tabId,
              sessionId: spec.claudeSessionId!,
              resume
            })
          : powershellLaunch(spec.tabId, this.runtimeDir, true)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: Math.max(spec.cols, 20),
        rows: Math.max(spec.rows, 5),
        cwd,
        env: launch.env as Record<string, string>,
        useConpty: true
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const entry: Running = { proc, pid: proc.pid, cwd, kind: spec.kind }
    this.running.set(spec.tabId, entry)

    proc.onData((data) => this.emit('data', { tabId: spec.tabId, data }))
    proc.onExit(({ exitCode }) => {
      // Nur aufräumen, wenn noch derselbe Prozess registriert ist — ein
      // zwischenzeitlicher Neustart darf nicht abgeräumt werden.
      if (this.running.get(spec.tabId)?.proc === proc) this.running.delete(spec.tabId)
      this.emit('exit', { tabId: spec.tabId, exitCode })
    })

    return { ok: true, claudeSessionId: spec.claudeSessionId, resumed: resume }
  }

  write(tabId: string, data: string): void {
    this.running.get(tabId)?.proc.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const entry = this.running.get(tabId)
    if (!entry) return
    try {
      entry.proc.resize(Math.max(cols, 20), Math.max(rows, 5))
    } catch {
      // Prozess ist zwischen Prüfung und resize gestorben — irrelevant.
    }
  }

  kill(tabId: string): void {
    const entry = this.running.get(tabId)
    if (!entry) return
    this.running.delete(tabId)
    try {
      entry.proc.kill()
    } catch {
      // bereits beendet
    }
  }

  killAll(): void {
    for (const tabId of [...this.running.keys()]) this.kill(tabId)
  }

  isRunning(tabId: string): boolean {
    return this.running.has(tabId)
  }

  /** tabId → Wurzel-PID, für die Prozessbaum-Auswertung. */
  pids(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [tabId, entry] of this.running) out.set(tabId, entry.pid)
    return out
  }

  shellTabIds(): string[] {
    return [...this.running.entries()]
      .filter(([, e]) => e.kind === 'powershell')
      .map(([tabId]) => tabId)
  }

  cwdOf(tabId: string): string | undefined {
    return this.running.get(tabId)?.cwd
  }
}
