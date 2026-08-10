import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { StartSpec, StartResult } from '@shared/types'
import { transcriptPath } from '../claude/paths'
import { hasConversation } from '../claude/transcripts'
import { claudeLaunch, powershellLaunch } from './launchers'

interface Running {
  proc: pty.IPty
  pid: number
  cwd: string
  kind: StartSpec['kind']
  /**
   * The session the process was launched with. It stays put for the life of the
   * process, while the conversation in the tab may move on — which is why session
   * switches are matched against this and not against state.json.
   */
  sessionId?: string
}

/**
 * Holds at most one PTY process per tab. Tabs without an entry are pure records
 * (lazy restore) — which is the normal state right after startup.
 */
export class PtyManager extends EventEmitter {
  private running = new Map<string, Running>()

  constructor(private readonly runtimeDir: string) {
    super()
  }

  start(spec: StartSpec): StartResult {
    this.kill(spec.tabId)

    const cwd = existsSync(spec.cwd) ? spec.cwd : homedir()

    // Only resume when a conversation really exists, otherwise `--resume` fails
    // with "No conversation found with session ID". What the renderer asked for
    // does not decide this — Claude Code's own storage does.
    const resume =
      spec.kind === 'claude' &&
      Boolean(spec.claudeSessionId) &&
      hasConversation(cwd, spec.claudeSessionId!)

    // An id can own a transcript without owning a conversation: `/clear` creates the
    // file, only the first prompt fills it. Handing that id to `--session-id` asks
    // Claude Code for a session it already has a file for, so the tab gets a fresh one
    // instead — the renderer learns from the result which id was really used.
    let sessionId = spec.claudeSessionId
    const taken =
      spec.kind === 'claude' &&
      !resume &&
      Boolean(sessionId) &&
      existsSync(transcriptPath(cwd, sessionId!))
    if (taken) sessionId = randomUUID()

    let launch
    try {
      launch =
        spec.kind === 'claude'
          ? claudeLaunch({
              tabId: spec.tabId,
              sessionId: sessionId!,
              resume,
              // A resumed session already lives in its worktree; asking for
              // another one would create a second, empty branch.
              worktree: spec.worktree && !resume
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

    const entry: Running = {
      proc,
      pid: proc.pid,
      cwd,
      kind: spec.kind,
      sessionId
    }
    this.running.set(spec.tabId, entry)

    proc.onData((data) => this.emit('data', { tabId: spec.tabId, data }))
    proc.onExit(({ exitCode }) => {
      // Only clean up while the same process is still registered — a restart
      // that happened in between must not be torn down.
      if (this.running.get(spec.tabId)?.proc === proc) this.running.delete(spec.tabId)
      this.emit('exit', { tabId: spec.tabId, exitCode })
    })

    return { ok: true, claudeSessionId: sessionId, resumed: resume }
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
      // The process died between the check and the resize — harmless.
    }
  }

  kill(tabId: string): void {
    const entry = this.running.get(tabId)
    if (!entry) return
    this.running.delete(tabId)
    try {
      entry.proc.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const tabId of [...this.running.keys()]) this.kill(tabId)
  }

  isRunning(tabId: string): boolean {
    return this.running.has(tabId)
  }

  /** tabId → root PID, used when walking the process tree. */
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

  /** The running Claude tabs with the session each of them was launched with. */
  claudeTabs(): { tabId: string; cwd: string; pid: number; sessionId: string }[] {
    const out: { tabId: string; cwd: string; pid: number; sessionId: string }[] = []
    for (const [tabId, entry] of this.running) {
      if (entry.kind === 'claude' && entry.sessionId) {
        out.push({ tabId, cwd: entry.cwd, pid: entry.pid, sessionId: entry.sessionId })
      }
    }
    return out
  }

  cwdOf(tabId: string): string | undefined {
    return this.running.get(tabId)?.cwd
  }
}
