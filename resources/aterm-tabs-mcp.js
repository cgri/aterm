// aterm - MCP server for Claude sessions running in aterm tabs.
//
// Claude Code starts it over stdio, as aterm's own executable with
// ELECTRON_RUN_AS_NODE=1, so it is plain Node without any dependencies. It
// speaks just enough MCP to offer its tools, and hands every call to the aterm
// that started the tab, over a named pipe: one JSON line there, one back.
//
// Arguments: --pipe <name> --tab <tabId>. Both come from the tab's own MCP
// config, which aterm writes per tab.

'use strict'

const net = require('node:net')
const readline = require('node:readline')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const PIPE = arg('--pipe')
const TAB = arg('--tab')

/**
 * Told to Claude Code once, at the start of every session, and put into its system prompt
 * as this server's instructions. The tool descriptions alone were not enough: a session
 * asked to create tasks and start on one created them, began working and never joined,
 * so the task list could show nothing of it.
 */
const INSTRUCTIONS = [
  'This session runs in an aterm tab. aterm keeps a task list the user follows beside the terminals.',
  'Whenever you start working on one of its tasks - because the user named it, asked you to pick one,',
  'or you created it to work on now - call task_join first (or task_create with join: true), so the',
  'list shows this session on it. task_join answers with when to report on the task through',
  'task_update; follow that for as long as the session is on the task.',
  'A task is one piece of work as the user sees it - a ticket, an issue, a topic - not one per',
  'repository: work that spans several repositories is still one task, and the sessions in those',
  'repositories (or one session working in all of them) are on that same task. Before creating a',
  'task, check task_list for one that already covers the work.'
].join(' ')

const TOOLS = [
  {
    name: 'open_tab',
    description:
      'Open a new aterm tab with a Claude Code session of its own, for a sub-task the user ' +
      'will work on interactively in that tab - typically one per repository when a change ' +
      'spans several. The tab opens in the background, next to this one. The new session is ' +
      'told who opened it and messages this session with SendMessage once its task is done, ' +
      'which may take many turns; do not wait or poll for it. Message it yourself with ' +
      'SendMessage, always by the sessionName this returns - never by the uds: address its ' +
      'messages come from, which belongs to one process and is gone once the session is ' +
      'resumed, as all of them are when aterm restarts. aterm decides the isolation for ' +
      '"auto": a fresh git worktree when the working tree has uncommitted changes or another ' +
      'session runs in it (this one included), the directory itself otherwise. Tell the user ' +
      'which isolation each tab got. Claude Code only creates a worktree in a folder the user ' +
      'has trusted; if it has not been, the call fails with its message - ask the user to ' +
      'start Claude there once and accept the trust question, then call again.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the directory the session starts in.' },
        prompt: {
          type: 'string',
          description:
            'The task for the new session: what to do and why, and what result to report back. ' +
            'It is the first prompt of that session, so it has to stand on its own.'
        },
        isolation: {
          type: 'string',
          enum: ['auto', 'worktree', 'inplace'],
          description: 'Leave at "auto" unless the user asked for one.'
        },
        title: {
          type: 'string',
          description: 'One to five words naming the task, e.g. "Fix login timeout". Names the tab and the new session.'
        },
        task: {
          type: 'string',
          description:
            'The aterm task the new session works on. Leave it out to put it on the task this session is on, if any; "none" for no task.'
        }
      },
      required: ['cwd', 'prompt', 'title']
    }
  },
  {
    name: 'close_tab',
    description:
      'Close a tab this session opened with open_tab. Only when the user asks for it: a ' +
      'finished tab stays open so the user can look at it. Refused while that session is ' +
      'working. A worktree it used is left in place.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'The tabId open_tab returned.' } },
      required: ['tabId']
    }
  },
  {
    name: 'review_text',
    description:
      'Show the user a text you are about to post or send on their behalf - a PR or MR ' +
      'description, an issue or ticket, a comment or review, a message - in a review panel ' +
      'beside this terminal, and wait for their decision. Use it whenever you would otherwise ' +
      'present such a text for approval. It blocks until the user decides, which may take a ' +
      'while; do not post anything before it returns APPROVED. The answer is one of: APPROVED ' +
      '(post exactly the text it returns between the markers - the user may have edited it), ' +
      'CHANGES REQUESTED (revise as the comments say and call this again with the revised ' +
      'text), REJECTED (do not post it), or NO DECISION (ask the user in the terminal). Pass ' +
      'the complete text exactly as it would be posted, title lines included where the target ' +
      'has them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'What the text is, in a few words, e.g. "PR description" or "Jira comment".'
        },
        target: {
          type: 'string',
          description:
            'Where it is going to be posted, e.g. "GitHub cgri/aterm PR #66" or "Jira BIO-1234".'
        },
        text: { type: 'string', description: 'The text, in Markdown, exactly as it would be posted.' }
      },
      required: ['title', 'target', 'text']
    }
  },
  {
    name: 'tab_status',
    description:
      "Every tab in this aterm window and what it is doing, as aterm's tab bar shows it: " +
      '"working" (busy), "waiting" (waiting for the user), "idle", "stopped" (restored, not ' +
      'started) or "exited". Your own tab is marked "you".',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'wait_for_idle',
    description:
      'Wait until no other tab in this aterm window is working - for example before the user ' +
      'restarts aterm, which ends every session in it. Tabs waiting for the user count as at ' +
      'rest; so does a shell tab running a command, which aterm cannot tell from one at rest. ' +
      'Returns IDLE with every tab\'s state, or TIMEOUT naming the tabs still working.',
    inputSchema: {
      type: 'object',
      properties: {
        quiet_seconds: {
          type: 'number',
          description: 'How long no other tab may have worked before it counts as idle. Default 5.'
        },
        timeout_minutes: { type: 'number', description: 'How long to wait at most. Default 30.' }
      }
    }
  },
  {
    name: 'task_list',
    description:
      "List the tasks in aterm's task list - the user's to-dos and the work on tickets and " +
      'issues, each with the sessions on it. Use it to find the task the user means.',
    inputSchema: {
      type: 'object',
      properties: { include_done: { type: 'boolean', description: 'Also list finished tasks.' } }
    }
  },
  {
    name: 'task_get',
    description: "One task's title, source, the user's notes, open asks and recent activity.",
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task id. Defaults to the task this session is on.' } }
    }
  },
  {
    name: 'task_create',
    description:
      "Add a task to aterm's task list - for work that comes up and is to be done later or by " +
      'another session. Only when the user asks for it or agrees. One task per piece of work as ' +
      'the user sees it (a ticket, an issue, a topic), never one per repository: work spanning ' +
      'several repositories is one task, with a note naming them. Check task_list first.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A few words naming the task.' },
        source: { type: 'string', description: 'A ticket key or an issue/PR/MR link, if there is one.' },
        notes: { type: 'string', description: 'What else there is to know, in a few lines.' },
        cwd: { type: 'string', description: 'Where a session on it would work. Defaults to this session\'s folder.' },
        join: {
          type: 'boolean',
          description: 'Put this session on the new task - set it when you are about to work on it. Default: it goes to the backlog.'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'task_join',
    description:
      'Put this session on an aterm task. Call it as soon as you start working on a task from the ' +
      'list, whoever picked it; without it the user sees nobody working on the task. A session is ' +
      'on one task at a time; several sessions can be on the same task. The answer says when to ' +
      'report with task_update.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The task id from task_list.' } },
      required: ['task']
    }
  },
  {
    name: 'task_leave',
    description: 'Take this session off its aterm task.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'task_update',
    description:
      "Report the state of this session's aterm task, which the user follows in aterm's task list. " +
      'Call it only on a change aterm cannot see itself: before you stop to ask the user a question ' +
      '(needs_user, ask "question"); when a PR/MR or other piece of work is ready for the user to ' +
      'review and merge (needs_user, ask "review", with url); when the task waits for someone other ' +
      'than the user (blocked); when you take it up again after one of those (working); when it is ' +
      'finished (done). Whether you are working at the moment aterm sees for itself.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'needs_user', 'blocked', 'done'] },
        note: {
          type: 'string',
          description:
            'One sentence for the task list: what the user is to decide or review, what the task is waiting for, or where it stands.'
        },
        ask: {
          type: 'string',
          enum: ['question', 'review'],
          description: 'With needs_user: a question to answer, or work to review and merge.'
        },
        url: { type: 'string', description: 'The PR/MR or page a review is about.' },
        resolve_reviews: {
          type: 'boolean',
          description: 'The PR/MR asked to be reviewed has been merged or closed: its review is no longer open.'
        },
        title: { type: 'string', description: 'A better title for the task, e.g. when it was created from a bare link.' },
        task: { type: 'string', description: 'Task id. Defaults to the task this session is on.' }
      },
      required: ['status']
    }
  }
]

/** Calls still waiting for aterm, by JSON-RPC id, so a cancellation can hang up on them. */
const inFlight = new Map()
/** Calls Claude Code cancelled, which are not to be answered. */
const cancelled = new Set()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

// `id` is the JSON-RPC id of the call: hanging up the pipe is how aterm learns that
// Claude Code cancelled it (Esc in the terminal), and takes the review panel down.
function callAterm(id, tool, args) {
  return new Promise((resolve) => {
    if (!PIPE || !TAB) {
      resolve({ ok: false, error: 'This session is not running in an aterm tab.' })
      return
    }
    const socket = net.connect(`\\\\.\\pipe\\${PIPE}`)
    inFlight.set(id, socket)
    socket.on('close', () => inFlight.delete(id))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ tabId: TAB, ppid: process.ppid, tool, args })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
    })
    socket.on('close', () => {
      try {
        resolve(JSON.parse(buffer.trim()))
      } catch {
        resolve({ ok: false, error: 'aterm closed the connection without an answer.' })
      }
    })
    socket.on('error', () => {
      // `close` follows and answers.
    })
  })
}

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aterm', version: '1' },
        instructions: INSTRUCTIONS
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const reply = await callAterm(id, params && params.name, (params && params.arguments) || {})
    // A cancelled call gets no answer: Claude Code has stopped waiting for it.
    if (cancelled.delete(id)) return
    send({
      jsonrpc: '2.0',
      id,
      result: reply.ok
        ? { content: [{ type: 'text', text: reply.text }] }
        : { content: [{ type: 'text', text: reply.error }], isError: true }
    })
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'notifications/cancelled') {
    const requestId = params && params.requestId
    const socket = inFlight.get(requestId)
    if (socket) {
      cancelled.add(requestId)
      socket.destroy()
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
  // Notifications (`notifications/initialized` and the like) need no answer.
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  void handle(message)
})
