import { existsSync, readFileSync } from 'node:fs'
import { parseJson } from '../util/json'
import { transcriptPath } from './paths'

export interface TranscriptHead {
  sessionId: string
  cwd: string
}

/** Reads the first `type:"user"` line — it carries both sessionId and cwd. */
export function firstUserEntry(file: string): TranscriptHead | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // The last line may still be half-written — just move on.
    const entry = parseJson<{ type?: string; sessionId?: string; cwd?: string }>(line)
    if (entry?.type === 'user' && entry.sessionId && entry.cwd) {
      return { sessionId: entry.sessionId, cwd: entry.cwd }
    }
  }
  return undefined
}

/**
 * Does a resumable conversation exist for this session?
 *
 * Claude Code only creates the transcript once something actually happened. A
 * session that was merely started and closed again has none, and
 * `claude --resume` then fails with "No conversation found with session ID".
 * That is why this looks at the file rather than at a flag in state.json.
 */
export function hasConversation(cwd: string, sessionId: string): boolean {
  const file = transcriptPath(cwd, sessionId)
  if (!existsSync(file)) return false
  // A file holding nothing but mode lines does not count as a conversation.
  return firstUserEntry(file) !== undefined
}
