/**
 * What a session is told about the aterm task it works on: which one, and when to report
 * on it. Shared by the tabs `open_tab` makes for a session on a task and the ones the user
 * starts from the task list, so both learn the same rules.
 *
 * Working and waiting for an answer are deliberately not asked for: aterm reads both off
 * the tab. A session only reports what aterm cannot see.
 */
export function taskBriefing(task: { id: string; number?: number; title: string }): string {
  return [
    `This session works on the aterm task ${taskRef(task)} ("${task.title}") and is attached to it in aterm's task list.`,
    'Report on it with the task_update tool of the aterm MCP server, each time with a one-sentence note:',
    '- status "needs_user", ask "question" - before you stop to ask the user to decide something;',
    '- status "needs_user", ask "review", url - when a PR/MR (or other piece of work) is ready for the user to review and merge;',
    '- status "blocked" - when the task waits for someone or something other than the user (CI, another team, another task, a review by colleagues); reviews asked before stay open but no longer show the task as needing the user;',
    '- status "working" - when you take up the task again after one of those;',
    '- status "done" - when the task is finished.',
    'Pass resolve_reviews (with url for just one) once a PR/MR you asked to be reviewed has been merged or closed.',
    'There is no need to report anything else: aterm sees for itself whether you are working.',
    'If the work takes you into another repository, it stays this task: do not create a task per repository.'
  ].join('\n')
}

/** The first prompt of a session the user starts on a task from the task list. */
export function taskStartPrompt(task: {
  id: string
  number?: number
  title: string
  source?: string
  notes?: string
}): string {
  return [
    `Task: ${task.title}`,
    ...(task.source ? [`Source: ${task.source}`] : []),
    ...(task.notes ? ['', 'Notes:', task.notes] : []),
    '',
    'Start by reading the source if there is one, then work on the task together with the user in this terminal; it may take many turns.',
    '',
    '---',
    taskBriefing(task)
  ].join('\n')
}

/**
 * The asks that put a task under "Needs you". A review asked before the task was blocked
 * waits behind the block - the PR/MR went to colleagues, say - and is back once it is
 * lifted; one asked after it counts. Questions older than a block are dropped when it is set.
 */
export function asksForUser<A extends { kind: string; at: number }>(task: {
  asks: A[]
  blocked?: string
  blockedAt?: number
}): A[] {
  if (!task.blocked) return task.asks
  const since = task.blockedAt ?? 0
  return task.asks.filter((a) => a.kind !== 'review' || a.at > since)
}

/** What a task is called: `T7`. Falls back on the internal id for a task without a number. */
export function taskRef(task: { id: string; number?: number }): string {
  return typeof task.number === 'number' ? `T${task.number}` : task.id
}
