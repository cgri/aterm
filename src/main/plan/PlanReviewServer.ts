import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { PlanReviewAnswer, PlanReviewRequest, PlanStartMode } from '@shared/types'

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

/**
 * The PermissionRequest hook answers at once from what the review left behind; it never
 * waits for anyone, so it gets no more time than a slow PowerShell start needs.
 */
const MENU_HOOK_TIMEOUT_S = 30

/**
 * How long an approval waits for the menu it answers. The menu follows the review within
 * a fraction of a second; an approval still lying around after this is not meant for
 * whatever menu comes next.
 */
const APPROVAL_TTL_MS = 30_000

interface Pending {
  socket: Socket
  ack?: NodeJS.Timeout
  /** Set for a review, so an approval knows which tab and which plan it answers. */
  tabId?: string
  plan?: string
}

/** A plan approved in the panel, waiting for Claude Code's menu to come up. */
interface Approval {
  plan: string
  mode: PlanStartMode
  notes?: string
  expires: number
}

/**
 * The aterm end of the `ExitPlanMode` hook. Tabs are started with `--settings` naming
 * a file written here, which registers `resources/aterm-plan-hook.ps1` twice: as a
 * PreToolUse hook, which is the review — the script connects to this pipe with the plan
 * and waits for the answer — and as a PermissionRequest hook, which answers Claude
 * Code's "Would you like to proceed?" menu for a plan the review approved.
 *
 * It takes both because neither does the whole job. PreToolUse runs before the menu is
 * drawn and Esc in the terminal ends it, but its `allow` still leaves the menu up. The
 * PermissionRequest hook can answer the menu, mode and all, but runs *beside* it: a menu
 * answered in the terminal leaves that hook running, and a review held there would stay
 * open for nothing until its timeout. Measured in 2.1.287.
 *
 * Events: `review` (PlanReviewRequest) when a plan arrives, `closed` (reviewId) when the
 * hook went away before it was answered — Claude Code timed it out, or the user pressed
 * Esc in the terminal, which cancels a running hook.
 */
export class PlanReviewServer extends EventEmitter {
  private server?: Server
  private readonly pending = new Map<string, Pending>()
  /** By tab id: one review per tab, so at most one approval per tab. */
  private readonly approvals = new Map<string, Approval>()
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

  /**
   * An approval is not answered here: `allow` from PreToolUse does not get past Claude
   * Code's own menu, so it is put aside for the PermissionRequest hook that menu fires,
   * and the review itself ends without a decision.
   */
  answer(reviewId: string, answer: PlanReviewAnswer): void {
    const entry = this.pending.get(reviewId)
    if (!entry) return
    if (answer.kind === 'approve' && entry.tabId && entry.plan !== undefined) {
      this.approvals.set(entry.tabId, {
        plan: entry.plan,
        mode: answer.mode,
        notes: answer.notes,
        expires: Date.now() + APPROVAL_TTL_MS
      })
      this.reply(reviewId, '')
      return
    }
    this.reply(reviewId, answer.kind === 'revise' ? reviseOutput(answer.feedback) : '')
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
      this.reply(reviewId, '')
      return
    }
    if (request.event === 'PermissionRequest') {
      this.reply(reviewId, this.takeApproval(request))
      return
    }
    // A new round: whatever was approved before it can no longer be meant.
    this.approvals.delete(request.tabId)
    const entry = this.pending.get(reviewId)!
    entry.tabId = request.tabId
    entry.plan = request.plan
    entry.ack = setTimeout(() => this.answer(reviewId, { kind: 'pass' }), ACK_TIMEOUT_MS)
    const review: PlanReviewRequest = { reviewId, tabId: request.tabId, plan: request.plan }
    this.emit('review', review)
  }

  /**
   * The menu's answer, when the review approved this very plan a moment ago. Anything
   * else — no approval, an old one, another plan — is no decision, and the menu stays up
   * for the user to answer in the terminal.
   */
  private takeApproval(request: HookRequest): string {
    const approval = this.approvals.get(request.tabId)
    this.approvals.delete(request.tabId)
    if (!approval || approval.expires < Date.now() || approval.plan !== request.plan) return ''
    return menuOutput(request.toolInput, approval)
  }

  private reply(reviewId: string, line: string): void {
    const entry = this.pending.get(reviewId)
    if (!entry) return
    this.pending.delete(reviewId)
    if (entry.ack) clearTimeout(entry.ack)
    entry.socket.end(`${line}\n`)
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
        ],
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [{ type: 'command', command, timeout: MENU_HOOK_TIMEOUT_S }]
          }
        ]
      }
    }
    const file = join(this.userData, 'plan-hook-settings.json')
    writeFileSync(file, JSON.stringify(settings, null, 2))
    return file
  }
}

interface HookRequest {
  event: 'PreToolUse' | 'PermissionRequest'
  tabId: string
  plan: string
  /** The tool input as Claude Code sent it, handed back whole with the approved plan. */
  toolInput: Record<string, unknown>
}

/** What the hook sent, reduced to what a review needs. Anything else is no plan. */
function parseRequest(line: string): HookRequest | undefined {
  try {
    const data = JSON.parse(line) as {
      tabId?: unknown
      hook?: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown }
    }
    const event = data.hook?.hook_event_name
    if (event !== 'PreToolUse' && event !== 'PermissionRequest') return undefined
    if (typeof data.tabId !== 'string' || data.hook?.tool_name !== 'ExitPlanMode') return undefined
    const toolInput = data.hook.tool_input
    if (!toolInput || typeof toolInput !== 'object') return undefined
    const plan = (toolInput as { plan?: unknown }).plan
    if (typeof plan !== 'string' || !plan.trim()) return undefined
    return { event, tabId: data.tabId, plan, toolInput: toolInput as Record<string, unknown> }
  } catch {
    return undefined
  }
}

/** Comments go back as the reason the plan was turned down; Claude revises it. */
function reviseOutput(feedback: string): string {
  return hookLine({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: feedback
    }
  })
}

/**
 * The answer to Claude Code's "Would you like to proceed?" menu. The comments are
 * appended to the plan itself, because that is what Claude carries out \u2014 and an `allow`
 * without `updatedInput` was measured to be ignored, menu and all, so the input always
 * goes back, changed or not.
 */
function menuOutput(toolInput: Record<string, unknown>, approval: Approval): string {
  const plan = approval.notes ? `${approval.plan.trimEnd()}\n\n${approval.notes}` : approval.plan
  return hookLine({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { ...toolInput, plan },
        updatedPermissions: [{ type: 'setMode', mode: approval.mode, destination: 'session' }]
      }
    }
  })
}

/**
 * The line the hook prints for Claude Code. Written as ASCII, with everything else
 * escaped, so no console code page between here and Claude Code can mangle an umlaut in
 * the user's comments. An empty line is "no decision".
 */
function hookLine(output: object): string {
  return JSON.stringify(output).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}
