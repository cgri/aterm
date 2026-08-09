import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import type { RecentSession } from '@shared/types'
import { parseJson } from '../util/json'
import { historyFile, transcriptPath } from './paths'

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

  /** Title of a known session (its first prompt), if there is one. */
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

    return [...byId.values()]
      .filter((s) => existsSync(transcriptPath(s.cwd, s.sessionId)))
      .map(({ firstAt: _firstAt, ...rest }) => rest)
      .sort((a, b) => b.lastUsed - a.lastUsed)
  }
}

export function cleanTitle(display: string | undefined): string {
  const text = (display ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '(untitled)'
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}
