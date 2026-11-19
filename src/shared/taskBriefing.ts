import type { TaskStep } from './types'
import { stepsLine } from './taskSteps'

/**
 * What a session is told about the aterm task it works on: which one, its chain of steps,
 * and how to keep that chain current. Shared by `task_join`, the tabs `open_tab` makes for
 * a session on a task and the ones the user starts from the task list, so all of them
 * learn the same rules.
 *
 * Working and waiting for an answer are deliberately not asked for: aterm reads both off
 * the tab. A session only reports what aterm cannot see - and the steps are the part the
 * user reads to see what is left and whose turn it is.
 */
export function taskBriefing(
  task: { id: string; number?: number; title: string; steps?: TaskStep[] },
  self?: string
): string {
  return [
    `This session works on the aterm task ${taskRef(task)} ("${task.title}") and is attached to it in aterm's task list.`,
    "Keep the task's steps current with task_update steps - the user reads them to see what is left and whose turn it is:",
    `- Steps: ${stepsLine({ steps: task.steps ?? [] }, self)}`,
    `- If there are none and the work takes more than one step, write the remaining chain now (replace: true), every step with its owner: "me", "user", a session's name, or who else.`,
    '- In the same call: mark your step done when you finish it, and take or add the next one.',
    '- Anything the user has to do (review, merge, decide, give a go) is a step owned by "user", with the url of the PR/MR where there is one.',
    '- Waiting for colleagues, CI or another team: a step owned by them, or blocked with a reason.',
    `- When you see that someone else's step is done (MR merged, release out), mark it done.`,
    '- A question you are about to ask the user: status "needs_user", ask "question", with a one-sentence note.',
    '- When the whole task is finished: status "done".',
    'aterm sees for itself whether you are working; report nothing else.',
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
  steps?: TaskStep[]
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

/** What a task is called: `T7`. Falls back on the internal id for a task without a number. */
export function taskRef(task: { id: string; number?: number }): string {
  return typeof task.number === 'number' ? `T${task.number}` : task.id
}
