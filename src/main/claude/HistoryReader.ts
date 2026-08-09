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
 * Liest ~/.claude/history.jsonl (eine Zeile je Prompt) und verdichtet sie zu
 * einer Liste von Sessions. Bewusst defensiv: kaputte oder unbekannte Zeilen
 * werden übersprungen, ein leeres Ergebnis ist kein Fehler.
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
      // Ohne Watcher greift einfach nur der Zeit-Cache.
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

  /** Titel einer bekannten Session (erster Prompt), falls vorhanden. */
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
      // Der Titel ist der *erste* Prompt — history.jsonl ist chronologisch,
      // aber darauf verlassen wir uns nicht.
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
  if (!text) return '(ohne Titel)'
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}
