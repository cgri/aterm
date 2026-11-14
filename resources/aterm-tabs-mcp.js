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
        serverInfo: { name: 'aterm', version: '1' }
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
