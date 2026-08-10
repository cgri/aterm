import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../util/json'
import { sessionsDir } from './paths'

/** A running interactive session, as Claude Code itself reports it. */
export interface LiveSession {
  /** The pid of the `claude` process. */
  pid: number
  /** The conversation it is in *right now* — this follows `/clear` and `/resume`. */
  sessionId: string
  /**
   * Where that process runs. For a `--worktree` tab this is the worktree, not the
   * directory the tab was started in, so it is no use for matching a tab.
   */
  cwd: string
}

const PID_JSON = /^(\d+)\.json$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Raw {
  pid?: number
  sessionId?: string
  cwd?: string
  kind?: string
}

/**
 * Reads `~/.claude/sessions/<pid>.json`. Claude Code writes one such file per
 * running session and rewrites it as the session goes on, so it names the
 * conversation a process is in *before* anything has been written to a transcript —
 * which is the only way to see a `/clear` that was never followed by a prompt.
 *
 * Undefined for anything unexpected; a half-written file comes again with the next
 * watcher event.
 */
export function readLiveSession(pid: number): LiveSession | undefined {
  const raw = readJsonFile<Raw>(join(sessionsDir(), `${pid}.json`))
  if (!raw) return undefined
  // A tab's conversation is an interactive one. Anything else — should Claude Code
  // ever register it here — is not this tab's.
  if (raw.kind && raw.kind !== 'interactive') return undefined
  if (!raw.sessionId || !UUID.test(raw.sessionId)) return undefined
  return { pid: raw.pid ?? pid, sessionId: raw.sessionId, cwd: raw.cwd ?? '' }
}

/** Every session currently registered. A handful of small files. */
export function listLiveSessions(): LiveSession[] {
  const out: LiveSession[] = []
  let names: string[]
  try {
    names = readdirSync(sessionsDir())
  } catch {
    return out
  }
  for (const name of names) {
    const pid = pidOfRegistryFile(name)
    if (pid === undefined) continue
    const entry = readLiveSession(pid)
    if (entry) out.push(entry)
  }
  return out
}

/** The pid a registry file name names, or undefined if it is not one of them. */
export function pidOfRegistryFile(filename: string): number | undefined {
  const match = PID_JSON.exec(filename)
  return match ? Number(match[1]) : undefined
}
