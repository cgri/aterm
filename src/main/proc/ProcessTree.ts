import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

interface ProcRow {
  ProcessId: number
  ParentProcessId: number
  Name: string
}

const POLL_MS = 3000
const AGENT_NAMES = new Set(['claude.exe'])

/**
 * Beantwortet je Tab die Frage „läuft hier gerade ein Claude-Prozess?".
 * Ein einziger langlebiger PowerShell-Prozess pollt den Prozessbaum — das ist
 * deutlich billiger, als alle drei Sekunden eine neue Shell zu starten.
 */
export class ProcessTree extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private buffer = ''
  private roots = new Map<string, number>()

  /** tabId → Wurzel-PID. Leere Map beendet den Poller. */
  setRoots(roots: Map<string, number>): void {
    this.roots = roots
    if (roots.size === 0) this.stop()
    else this.start()
  }

  private start(): void {
    if (this.child) return

    const script =
      `while ($true) { ` +
      `Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name FROM Win32_Process' | ` +
      `Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress -Depth 2; ` +
      `Start-Sleep -Milliseconds ${POLL_MS} }`

    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )

    try {
      this.child = spawn(powershell, ['-NoLogo', '-NoProfile', '-Command', script], {
        windowsHide: true
      })
    } catch {
      return
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.on('exit', () => {
      this.child = undefined
      this.buffer = ''
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
    this.buffer = ''
  }

  /**
   * ConvertTo-Json -Compress liefert je Durchlauf genau eine Zeile (ein Array).
   * Sehr lange Zeilen können über mehrere Chunks kommen.
   */
  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.evaluate(line)
      newline = this.buffer.indexOf('\n')
    }
    // Schutz gegen unbegrenztes Wachstum bei kaputter Ausgabe.
    if (this.buffer.length > 8_000_000) this.buffer = ''
  }

  private evaluate(line: string): void {
    let rows: ProcRow[]
    try {
      const parsed = JSON.parse(line) as ProcRow[] | ProcRow
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }

    const children = new Map<number, number[]>()
    const names = new Map<number, string>()
    for (const row of rows) {
      if (typeof row?.ProcessId !== 'number') continue
      names.set(row.ProcessId, (row.Name ?? '').toLowerCase())
      const list = children.get(row.ParentProcessId)
      if (list) list.push(row.ProcessId)
      else children.set(row.ParentProcessId, [row.ProcessId])
    }

    const running: Record<string, boolean> = {}
    for (const [tabId, rootPid] of this.roots) {
      running[tabId] = hasAgentDescendant(rootPid, children, names)
    }
    this.emit('activity', { running })
  }
}

function hasAgentDescendant(
  root: number,
  children: Map<number, number[]>,
  names: Map<number, string>
): boolean {
  const queue = [...(children.get(root) ?? [])]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    if (AGENT_NAMES.has(names.get(pid) ?? '')) return true
    queue.push(...(children.get(pid) ?? []))
  }
  return false
}
