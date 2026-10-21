// aterm - MCP server for Claude sessions running in aterm tabs.
//
// Claude Code starts it over stdio, as aterm's own executable with
// ELECTRON_RUN_AS_NODE=1, so it is plain Node without any dependencies. It
// speaks just enough MCP to offer two tools, and hands every call to the aterm
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
      'SendMessage, using the sessionName this returns. aterm decides the isolation for ' +
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
        title: { type: 'string', description: 'A few words naming the task, shown on the tab.' }
      },
      required: ['cwd', 'prompt']
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
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function callAterm(tool, args) {
  return new Promise((resolve) => {
    if (!PIPE || !TAB) {
      resolve({ ok: false, error: 'This session is not running in an aterm tab.' })
      return
    }
    const socket = net.connect(`\\\\.\\pipe\\${PIPE}`)
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
    const reply = await callAterm(params && params.name, (params && params.arguments) || {})
    send({
      jsonrpc: '2.0',
      id,
      result: reply.ok
        ? { content: [{ type: 'text', text: reply.text }] }
        : { content: [{ type: 'text', text: reply.error }], isError: true }
    })
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
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
