import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { PlanReviewAnswer, PlanReviewRequest } from '@shared/types'

/**
 * How long Claude Code lets the hook wait for the user. A plan may sit there over
 * lunch; the hook process costs nothing while it waits, and Esc in the terminal ends
 * it at any time.
 */
const HOOK_TIMEOUT_S = 24 * 60 * 60

/** A request larger than this is not a plan, and the connection is dropped. */
const MAX_REQUEST = 8 * 1024 * 1024

/**
 * How long the renderer has to confirm that it took a review. A review sent while the
 * renderer is loading is dropped by `send`, and nobody would ever answer it: the hook
 * would keep the terminal on hold until the timeout above.
 */
const ACK_TIMEOUT_MS = 5000

interface Pending {
  socket: Socket
  ack?: NodeJS.Timeout
}

/**
 * The aterm end of the `ExitPlanMode` hook. Tabs are started with `--settings` naming
 * a file written here, which registers `resources/aterm-plan-hook.ps1` as a PreToolUse
 * hook; that script connects to this pipe with the plan and waits for the answer.
 *
 * Events: `review` (PlanReviewRequest) when a plan arrives, `closed` (reviewId) when the
 * hook went away before it was answered — Claude Code timed it out, or the user pressed
 * Esc in the terminal, which cancels a running hook.
 */
export class PlanReviewServer extends EventEmitter {
  private server?: Server
  private readonly pending = new Map<string, Pending>()
  /** Per process, so a dev run and the installed app each get their own pipe. */
  private readonly pipeName = `aterm-plan-${process.pid}`

  constructor(
    private readonly userData: string,
    private readonly hookScript: string
  ) {
    super()
  }

  /**
   * Opens the pipe and writes the settings file. Returns the file for `--settings`, or
   * undefined when the pipe could not be opened — the tabs then start without the hook.
   */
  start(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', () => resolve(undefined))
      server.listen(`\\\\.\\pipe\\${this.pipeName}`, () => {
        this.server = server
        try {
          resolve(this.writeSettings())
        } catch {
          resolve(undefined)
        }
      })
    })
  }

  stop(): void {
    for (const reviewId of [...this.pending.keys()]) this.answer(reviewId, { kind: 'pass' })
    this.server?.close()
    this.server = undefined
  }

  /** The renderer has the review and will answer it. */
  acknowledge(reviewId: string): void {
    const entry = this.pending.get(reviewId)
    if (!entry?.ack) return
    clearTimeout(entry.ack)
    entry.ack = undefined
  }

  answer(reviewId: string, answer: PlanReviewAnswer): void {
    const entry = this.pending.get(reviewId)
    if (!entry) return
    this.pending.delete(reviewId)
    if (entry.ack) clearTimeout(entry.ack)
    entry.socket.end(`${hookOutput(answer)}\n`)
  }

  /** Every open review goes back without a decision — the renderer that held them is gone. */
  passAll(): void {
    for (const reviewId of [...this.pending.keys()]) this.answer(reviewId, { kind: 'pass' })
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    let reviewId: string | undefined

    socket.on('data', (chunk: string) => {
      if (reviewId) return
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) {
        if (buffer.length > MAX_REQUEST) socket.destroy()
        return
      }
      reviewId = randomUUID()
      this.pending.set(reviewId, { socket })
      this.receive(reviewId, buffer.slice(0, end))
    })
    socket.on('close', () => {
      if (reviewId && this.pending.has(reviewId)) {
        const entry = this.pending.get(reviewId)!
        if (entry.ack) clearTimeout(entry.ack)
        this.pending.delete(reviewId)
        this.emit('closed', reviewId)
      }
    })
    socket.on('error', () => {
      // A hook that was killed mid-write; `close` follows.
    })
  }

  private receive(reviewId: string, line: string): void {
    const request = parseRequest(line)
    if (!request) {
      this.answer(reviewId, { kind: 'pass' })
      return
    }
    const entry = this.pending.get(reviewId)!
    entry.ack = setTimeout(() => this.answer(reviewId, { kind: 'pass' }), ACK_TIMEOUT_MS)
    const review: PlanReviewRequest = { reviewId, ...request }
    this.emit('review', review)
  }

  private writeSettings(): string {
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    // Forward slashes, quoted: Claude Code may run the command through Git Bash or
    // through cmd, and a backslash means something different to each of them.
    const slash = (p: string): string => p.replace(/\\/g, '/')
    const command =
      `"${slash(powershell)}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
      `-File "${slash(this.hookScript)}" -Pipe ${this.pipeName}`

    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'ExitPlanMode',
            hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }]
          }
        ]
      }
    }
    const file = join(this.userData, 'plan-hook-settings.json')
    writeFileSync(file, JSON.stringify(settings, null, 2))
    return file
  }
}

/** What the hook sent, reduced to what a review needs. Anything else is no plan. */
function parseRequest(line: string): Omit<PlanReviewRequest, 'reviewId'> | undefined {
  try {
    const data = JSON.parse(line) as {
      tabId?: unknown
      hook?: { tool_name?: unknown; tool_input?: { plan?: unknown } }
    }
    const plan = data.hook?.tool_input?.plan
    if (typeof data.tabId !== 'string' || data.hook?.tool_name !== 'ExitPlanMode') return undefined
    if (typeof plan !== 'string' || !plan.trim()) return undefined
    return { tabId: data.tabId, plan }
  } catch {
    return undefined
  }
}

/**
 * The line the hook prints for Claude Code. Written as ASCII, with everything else
 * escaped, so no console code page between here and Claude Code can mangle an umlaut in
 * the user's comments. An empty line is "no decision".
 */
function hookOutput(answer: PlanReviewAnswer): string {
  if (answer.kind === 'pass') return ''
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: answer.kind === 'approve' ? 'allow' : 'deny',
      permissionDecisionReason:
        answer.kind === 'approve' ? 'The user approved the plan in aterm.' : answer.feedback
    }
  }
  return JSON.stringify(output).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}
