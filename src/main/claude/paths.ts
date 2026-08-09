import { homedir } from 'node:os'
import { join } from 'node:path'

export function claudeDir(): string {
  return join(homedir(), '.claude')
}

export function projectsDir(): string {
  return join(claudeDir(), 'projects')
}

export function historyFile(): string {
  return join(claudeDir(), 'history.jsonl')
}

/**
 * Claude Code legt Transkripte unter projects/<cwd mit [^A-Za-z0-9] → '-'> ab,
 * z. B. C:\projects\meinprojekt → C--projects-meinprojekt.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectsDir(), encodeProjectDir(cwd), `${sessionId}.jsonl`)
}
