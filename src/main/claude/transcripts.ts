import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { parseJson } from '../util/json'
import { encodeProjectDir, projectsDir, transcriptPath } from './paths'

export interface TranscriptHead {
  sessionId: string
  cwd: string
}

/**
 * The two identities a transcript line carries. They differ as soon as the user
 * runs `/clear` or `/resume`: the process keeps the session it was started with,
 * while the conversation moves on to another id.
 */
export interface TranscriptOrigin {
  /** `sessionId` — the conversation stored in this file. */
  sessionId: string
  /** `session_id` — the session the writing process was launched with. */
  processSessionId: string
}

/** Enough of the tail to hold a whole line; transcripts reach several megabytes. */
const TAIL_BYTES = 64 * 1024

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

function originOf(line: string): TranscriptOrigin | undefined {
  const entry = parseJson<{ sessionId?: string; session_id?: string }>(line)
  if (!entry?.sessionId || !entry.session_id) return undefined
  return { sessionId: entry.sessionId, processSessionId: entry.session_id }
}

/**
 * The first line carrying both ids — the answer to "which session forked this file
 * off?". Only the beginning answers that: a later run resuming this conversation
 * writes its own `session_id` into the same file.
 */
export function transcriptOrigin(file: string): TranscriptOrigin | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const origin = originOf(line)
    if (origin) return origin
  }
  return undefined
}

/**
 * The last line carrying both ids — the answer to "which conversation is the
 * process that started as X writing into right now?". That changes when a running
 * tab resumes another session. Reads the tail only.
 */
export function transcriptTail(file: string): TranscriptOrigin | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // Unless the whole file fitted, the first line is cut in half.
    if (length < size) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      const origin = originOf(lines[i])
      if (origin) return origin
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
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
  return findConversation(cwd, sessionId) !== undefined
}

/** Where a conversation lives, and the directory `claude` has to run in to resume it. */
export interface ConversationLocation {
  file: string
  cwd: string
}

/**
 * Finds the conversation a tab in `cwd` can resume — in `cwd` itself, or in one of its
 * worktrees. A tab started with `claude --worktree` keeps the project as its directory,
 * while Claude Code runs in `<project>\.claude\worktrees\<name>` and files the transcript
 * under *that*. Looking only under the project took such a tab for one without a
 * conversation, and the next start opened an empty session in the project instead.
 *
 * A worktree's own `cwd` is taken from the transcript rather than decoded from the
 * directory name, which loses every character that is not a letter or digit. A worktree
 * that has since been removed has nothing left to resume in, so it does not count.
 */
export function findConversation(cwd: string, sessionId: string): ConversationLocation | undefined {
  const own = transcriptPath(cwd, sessionId)
  // A file holding nothing but mode lines does not count as a conversation.
  if (existsSync(own) && firstUserEntry(own)) return { file: own, cwd }

  for (const file of worktreeTranscripts(cwd, sessionId)) {
    const head = firstUserEntry(file)
    if (head && existsSync(head.cwd)) return { file, cwd: head.cwd }
  }
  return undefined
}

/**
 * Does a transcript for this session exist at all, conversation or not? Such an id is
 * taken: Claude Code has a file for it, so it must not be handed to `--session-id`.
 */
export function hasTranscript(cwd: string, sessionId: string): boolean {
  return existsSync(transcriptPath(cwd, sessionId)) || worktreeTranscripts(cwd, sessionId).length > 0
}

/**
 * The session's transcripts under the worktrees of `cwd`. Their project directories
 * all start with the encoded `<cwd>\.claude\worktrees\`, so one listing of the projects
 * directory finds them without touching the worktrees themselves.
 */
function worktreeTranscripts(cwd: string, sessionId: string): string[] {
  const prefix = `${encodeProjectDir(join(cwd, '.claude', 'worktrees'))}-`
  let names: string[]
  try {
    names = readdirSync(projectsDir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(projectsDir(), name, `${sessionId}.jsonl`))
    .filter((file) => existsSync(file))
}
