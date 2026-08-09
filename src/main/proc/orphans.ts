import { spawn } from 'node:child_process'
import { join } from 'node:path'

interface ProcRow {
  ProcessId: number
  ParentProcessId: number
  Name: string
  CommandLine: string | null
  /** Creation time in ticks, only ever compared against another row's. */
  Created: number | null
}

/**
 * How a tab process looks from the outside. The profile has to be matched as the
 * `-File` argument, not just as a substring: any shell whose command line happens to
 * mention the script — a grep for it, for instance — would otherwise qualify.
 */
const SESSION_ARG = /--(?:session-id|resume)\s+[0-9a-f]{8}-[0-9a-f]{4}-/i
const PROFILE_ARG = /-File\s+"?[^"]*aterm-profile\.ps1/i

function system32(exe: string): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe)
}

/**
 * Ends tab processes that outlived the aterm that started them.
 *
 * `before-quit` kills every PTY, but an installer or a task-manager kill ends aterm
 * with `TerminateProcess` and it never runs. The children hang off their ConPTY
 * rather than a job object, so they can survive — and a `claude` still holding a
 * session while aterm resumes that same session is what destroys a conversation.
 *
 * A process counts as orphaned when the pid it claims as its parent is gone (or
 * belongs to a younger process, pids being recycled). That is what separates our
 * leftovers from a `claude` the user is running in some other terminal right now, and
 * from the tabs of any aterm — dev or installed — that is still alive: their parent
 * is still there. Nothing here looks at session ids, so a conversation that moved on
 * is covered too.
 */
export function reapOrphanTabs(): void {
  const script =
    `Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name,CommandLine,CreationDate FROM Win32_Process' | ` +
    `Select-Object ProcessId,ParentProcessId,Name,CommandLine,` +
    `@{n='Created';e={$_.CreationDate.Ticks}} | ConvertTo-Json -Compress -Depth 2`

  let child
  try {
    child = spawn(
      system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      ['-NoLogo', '-NoProfile', '-Command', script],
      { windowsHide: true }
    )
  } catch {
    // Without the process list there is nothing to decide on.
    return
  }

  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    out += chunk
    // The list is a few hundred kilobytes; anything beyond that has gone wrong.
    if (out.length > 8_000_000) out = ''
  })
  child.on('error', () => undefined)
  child.on('close', () => {
    for (const pid of orphanPids(out)) kill(pid)
  })
}

/** Split out from the process handling so the decision is testable by eye. */
function orphanPids(json: string): number[] {
  let rows: ProcRow[]
  try {
    const parsed = JSON.parse(json) as ProcRow[] | ProcRow
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }

  const byPid = new Map<number, ProcRow>()
  for (const row of rows) {
    if (typeof row?.ProcessId === 'number') byPid.set(row.ProcessId, row)
  }

  const pids: number[] = []
  for (const row of byPid.values()) {
    if (isTabProcess(row) && isOrphan(row, byPid)) pids.push(row.ProcessId)
  }
  return pids
}

function isTabProcess(row: ProcRow): boolean {
  const cmd = row.CommandLine ?? ''
  switch ((row.Name ?? '').toLowerCase()) {
    case 'claude.exe':
      return SESSION_ARG.test(cmd)
    case 'powershell.exe':
      return PROFILE_ARG.test(cmd)
    default:
      return false
  }
}

function isOrphan(row: ProcRow, byPid: Map<number, ProcRow>): boolean {
  const parent = byPid.get(row.ParentProcessId)
  if (!parent) return true
  if (typeof parent.Created !== 'number' || typeof row.Created !== 'number') return false
  // A parent that started after its child is a different process wearing a reused pid.
  return parent.Created > row.Created
}

/** /T as well: a Claude session may have subagents of its own below it. */
function kill(pid: number): void {
  try {
    spawn(system32('taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true
    }).on('error', () => undefined)
  } catch {
    // Gone in the meantime, or not ours to kill.
  }
}
