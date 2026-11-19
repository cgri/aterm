import type { Task, TaskStep, TaskStepOwner } from './types'

/**
 * Where a step stands by what is stored alone. The renderer adds what only the tabs know -
 * whether the owning session works or waits - on top of `current`.
 *
 * - `done`: ticked off.
 * - `current`: not done, and everything it comes after is.
 * - `blocked`: current, but waiting for a third party - declared, or owned by someone
 *   outside aterm.
 * - `later`: something it comes after is still open.
 */
export type StepBase = 'done' | 'current' | 'blocked' | 'later'

/**
 * What each step comes after: its `after`, or every step before it in the array. Only the
 * one before it was the first rule, and a step done out of order made the next one current
 * while an earlier one was still open - "Merge" asked for the user's go with a release
 * before it undone. An id that names no step (it was removed) is no obstacle.
 */
export function stepDependencies(steps: TaskStep[], index: number): number[] {
  const step = steps[index]
  if (step.after) return step.after
  return steps.slice(0, index).map((s) => s.id)
}

export function stepBases(steps: TaskStep[]): Map<number, StepBase> {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const bases = new Map<number, StepBase>()
  steps.forEach((step, i) => {
    if (step.done) {
      bases.set(step.id, 'done')
      return
    }
    const open = stepDependencies(steps, i).some((id) => {
      const dep = byId.get(id)
      return dep !== undefined && !dep.done
    })
    if (open) bases.set(step.id, 'later')
    else bases.set(step.id, step.blocked || step.owner.kind === 'other' ? 'blocked' : 'current')
  })
  return bases
}

/** The steps that can be worked on now, blocked ones included, in display order. */
export function currentSteps(task: Pick<Task, 'steps'>): TaskStep[] {
  const bases = stepBases(task.steps)
  return task.steps.filter((s) => {
    const base = bases.get(s.id)
    return base === 'current' || base === 'blocked'
  })
}

/**
 * A block holds back what the user was to do before it: a PR/MR handed to colleagues is
 * still open, but not the user's to do, and blocking is how both the user and a session
 * say so. A step added or changed after the block is due all the same.
 */
export function heldByBlock(task: Pick<Task, 'blocked' | 'blockedAt'>, step: TaskStep): boolean {
  return Boolean(task.blocked) && step.at <= (task.blockedAt ?? Number.POSITIVE_INFINITY)
}

/** "3/8": how many steps are done, of how many. */
export function stepProgress(task: Pick<Task, 'steps'>): { done: number; total: number } {
  return { done: task.steps.filter((s) => s.done).length, total: task.steps.length }
}

/**
 * The owner as a session reads it in a tool's answer: `user`, a session's name - `me` for
 * the session reading it - or whoever else.
 */
export function ownerText(owner: TaskStepOwner, self?: string): string {
  switch (owner.kind) {
    case 'user':
      return 'user'
    case 'session':
      return self && owner.name.toLowerCase() === self.toLowerCase() ? 'me' : owner.name
    case 'other':
      return owner.who
  }
}

/**
 * The chain in one line, for the answers of the `task_*` tools: the session learns the ids
 * and what is open after every call, at the cost of a line. Done steps are only counted by
 * id, open ones carry their title and owner.
 *
 *     ✓1-3 ●4 Merge lib !60 (user) ○5 Release lib 9.4.0 (me, after 4) ⛔6 Config review (colleagues)
 */
export function stepsLine(task: Pick<Task, 'steps'>, self?: string): string {
  if (task.steps.length === 0) return '(none yet)'
  const bases = stepBases(task.steps)
  const parts: string[] = []
  const done = task.steps.filter((s) => s.done).map((s) => s.id)
  if (done.length > 0) parts.push(`✓${ranges(done)}`)
  for (const step of task.steps) {
    const base = bases.get(step.id)
    if (base === 'done') continue
    const mark = base === 'current' ? '●' : base === 'blocked' ? '⛔' : '○'
    const extra = [ownerText(step.owner, self)]
    // Only an `after` that says something the order does not.
    if (step.after) extra.push(step.after.length ? `after ${step.after.join(',')}` : 'no dependencies')
    if (step.blocked) extra.push(`blocked: ${step.blocked}`)
    parts.push(`${mark}${step.id} ${step.title} (${extra.join(', ')})`)
  }
  return parts.join(' ')
}

/** 1,2,3,5 → "1-3,5". */
function ranges(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b)
  const out: string[] = []
  let start = sorted[0]
  let prev = start
  for (const id of [...sorted.slice(1), Number.NaN]) {
    if (id === prev + 1) {
      prev = id
      continue
    }
    out.push(start === prev ? String(start) : `${start}-${prev}`)
    start = id
    prev = id
  }
  return out.join(',')
}
