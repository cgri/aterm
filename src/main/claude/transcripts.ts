import { existsSync, readFileSync } from 'node:fs'
import { parseJson } from '../util/json'
import { transcriptPath } from './paths'

export interface TranscriptHead {
  sessionId: string
  cwd: string
}

/** Liest die erste `type:"user"`-Zeile — sie enthält sessionId und cwd. */
export function firstUserEntry(file: string): TranscriptHead | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // Die letzte Zeile kann noch unvollständig sein — dann einfach weiter.
    const entry = parseJson<{ type?: string; sessionId?: string; cwd?: string }>(line)
    if (entry?.type === 'user' && entry.sessionId && entry.cwd) {
      return { sessionId: entry.sessionId, cwd: entry.cwd }
    }
  }
  return undefined
}

/**
 * Gibt es zu dieser Session ein fortsetzbares Gespräch?
 *
 * Claude Code legt das Transkript erst an, wenn wirklich etwas passiert ist.
 * Eine Session, die nur gestartet und sofort wieder beendet wurde, hat keines —
 * `claude --resume` scheitert dann mit „No conversation found with session ID".
 * Deshalb entscheidet dieser Blick auf die Datei, nicht ein Merker in state.json.
 */
export function hasConversation(cwd: string, sessionId: string): boolean {
  const file = transcriptPath(cwd, sessionId)
  if (!existsSync(file)) return false
  // Eine Datei mit bloßen Modus-Zeilen zählt nicht als Gespräch.
  return firstUserEntry(file) !== undefined
}
