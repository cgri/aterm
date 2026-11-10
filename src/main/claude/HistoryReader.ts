import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { projectDir } from '@shared/paths'
import type { RecentSession } from '@shared/types'
import { parseJson } from '../util/json'
import { historyFile, transcriptPath } from './paths'
import { transcriptTitle } from './transcripts'

interface HistoryLine {
  display?: string
  timestamp?: number
  project?: string
  sessionId?: string
}

const CACHE_MS = 5000

/**
 * Reads ~/.claude/history.jsonl (one line per prompt) and condenses it into a
 * list of sessions. Deliberately defensive: broken or unknown lines are skipped,
 * and an empty result is not an error.
 */
export class HistoryReader {
  private cache?: { at: number; value: RecentSession[] }
  /** Transcript titles by file, valid while the file's size and mtime stay. */
  private titles = new Map<string, { stamp: string; title?: string }>()
  private watcher?: FSWatcher

  constructor() {
    this.startWatching()
  }

  private startWatching(): void {
    const file = historyFile()
    if (!existsSync(file)) return
    try {
      this.watcher = watch(file, () => {
        this.cache = undefined
      })
    } catch {
      // Without a watcher the time-based cache is all that applies.
    }
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = undefined
  }

  recent(): RecentSession[] {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value
    const value = this.read()
    this.cache = { at: Date.now(), value }
    return value
  }

  /** Title of a known session, if there is one. */
  titleFor(sessionId: string): string | undefined {
    return this.recent().find((s) => s.sessionId === sessionId)?.title
  }

  private read(): RecentSession[] {
    const file = historyFile()
    if (!existsSync(file)) return []

    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return []
    }

    const byId = new Map<string, RecentSession & { firstAt: number }>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const entry = parseJson<HistoryLine>(line)
      if (!entry) continue
      const { sessionId, project, display, timestamp } = entry
      if (!sessionId || !project || typeof timestamp !== 'number') continue

      const existing = byId.get(sessionId)
      if (!existing) {
        byId.set(sessionId, {
          sessionId,
          cwd: project,
          title: cleanTitle(display),
          lastUsed: timestamp,
          promptCount: 1,
          firstAt: timestamp
        })
        continue
      }
      existing.promptCount += 1
      if (timestamp > existing.lastUsed) existing.lastUsed = timestamp
      // The title is the *first* prompt. history.jsonl is chronological, but we
      // do not rely on that.
      if (timestamp < existing.firstAt) {
        existing.firstAt = timestamp
        existing.title = cleanTitle(display)
      }
    }

    const sessions: RecentSession[] = []
    for (const { firstAt: _firstAt, ...entry } of byId.values()) {
      const found = locateTranscript(entry.cwd, entry.sessionId)
      if (!found) continue
      const session = { ...entry, cwd: found.cwd }
      const title = this.transcriptTitle(found.file, found.stamp)
      sessions.push(title ? { ...session, title: cleanTitle(title) } : session)
    }
    return sessions.sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /**
   * The name Claude Code itself shows — the one the tab carries while the session
   * runs. The first prompt is only what is left when the transcript names none.
   */
  private transcriptTitle(file: string, stamp: string): string | undefined {
    const cached = this.titles.get(file)
    if (cached?.stamp === stamp) return cached.title
    const title = transcriptTitle(file)
    this.titles.set(file, { stamp, title })
    return title
  }
}

/**
 * The session's transcript, and the directory to resume it in. history.jsonl names
 * where `claude` ran, which for a `--worktree` session is the worktree. Removing the
 * worktree on exit moves the transcript to the project's directory, so a session whose
 * worktree is gone is found, and resumed, under its project.
 */
function locateTranscript(
  cwd: string,
  sessionId: string
): { file: string; cwd: string; stamp: string } | undefined {
  const candidates = [cwd, projectDir(cwd)].filter((dir, i, all) => all.indexOf(dir) === i)
  for (const dir of candidates) {
    const file = transcriptPath(dir, sessionId)
    try {
      const stat = statSync(file)
      return { file, cwd: dir, stamp: `${stat.size}:${stat.mtimeMs}` }
    } catch {
      // Not here; try the next one.
    }
  }
  return undefined
}

export function cleanTitle(display: string | undefined): string {
  const text = (display ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '(untitled)'
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}
