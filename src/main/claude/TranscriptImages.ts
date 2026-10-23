import { EventEmitter } from 'node:events'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TabImagesEvent, TranscriptImage } from '@shared/types'
import { parseJson } from '../util/json'
import { projectsDir } from './paths'

/** The scheme the renderer loads an image from; the host is always `img`. */
export const IMAGE_SCHEME = 'aterm-image'

/**
 * How far back a transcript is searched when a tab starts following it. Transcripts
 * reach hundreds of megabytes — every image is in them twice, as base64 — and the
 * panel is about what happened lately, not about the whole history.
 */
const HISTORY_BYTES = 32 * 1024 * 1024

/** Read in pieces, so a large transcript never sits in memory as one string. */
const CHUNK_BYTES = 4 * 1024 * 1024

/** Per tab. The oldest are forgotten first; the panel never shows more than this. */
const MAX_IMAGES = 200

/** Where an image's base64 lives: one transcript line, and the block inside it. */
interface ImageRef {
  file: string
  offset: number
  length: number
  /** Index into `message.content`, then into a tool result's own `content`. */
  block: number[]
}

interface Followed {
  conversationId: string
  file?: string
  /** Everything before this has been read; it is always the start of a line. */
  offset: number
  /** tool_use id → what the tool was asked for, so a result can say what it shows. */
  toolUses: Map<string, { name: string; path?: string }>
  imageIds: string[]
}

interface ContentBlock {
  type?: string
  tool_use_id?: string
  content?: unknown
  source?: { type?: string; data?: string; media_type?: string }
}

interface TranscriptLine {
  type?: string
  isSidechain?: boolean
  message?: { content?: unknown }
  toolUseResult?: { file?: { dimensions?: { displayWidth?: number; displayHeight?: number } } }
}

/**
 * The images a tab's conversation has seen: what the user pasted and what a tool
 * returned — the Read tool on an image file, a screenshot from an MCP server.
 *
 * Claude Code shows none of them in the terminal, but every one is in the transcript
 * as a base64 block. Only where it is gets remembered here — file, line offset and
 * block — and `serve` reads it back when the renderer asks, so nothing of the image
 * itself is held in memory or sent over IPC. That also keeps an image on show after
 * the file it was read from has been changed or deleted.
 *
 * Images a tool *wrote* are not in the transcript and cannot be shown; Claude Code's
 * Write tool takes text only, and anything else comes out of a Bash command that
 * nobody here can see into.
 */
export class TranscriptImages extends EventEmitter {
  private readonly tabs = new Map<string, Followed>()
  private readonly images = new Map<string, ImageRef & { path?: string }>()
  private nextId = 1

  /**
   * The conversation each running tab is in, after every change. A tab whose
   * conversation moved on (`/clear`, `/resume`) starts over with the new one.
   */
  follow(conversations: Map<string, string>): void {
    for (const [tabId, followed] of this.tabs) {
      if (conversations.get(tabId) !== followed.conversationId) this.drop(tabId)
    }
    for (const [tabId, conversationId] of conversations) {
      if (this.tabs.has(tabId)) continue
      const followed: Followed = { conversationId, offset: 0, toolUses: new Map(), imageIds: [] }
      this.tabs.set(tabId, followed)
      followed.file = locate(conversationId)
      const added = followed.file ? this.read(followed, true) : []
      this.emitImages({ tabId, reset: true, images: added })
    }
  }

  /**
   * Starts every tab over: a reloaded renderer has lost what it was sent, and the next
   * `follow` sends each tab its images again.
   */
  forgetAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.drop(tabId)
  }

  /** A transcript under ~/.claude/projects was written to; `rel` is relative to it. */
  changed(rel: string): void {
    const conversationId = basename(rel, '.jsonl')
    for (const [tabId, followed] of this.tabs) {
      if (followed.conversationId !== conversationId) continue
      // A fresh conversation has no file until its first prompt.
      followed.file ??= join(projectsDir(), rel)
      const added = this.read(followed, false)
      if (added.length > 0) this.emitImages({ tabId, reset: false, images: added })
    }
  }

  /** The file a tool result was read from, if it named one and it still exists. */
  pathOf(imageId: string): string | undefined {
    const path = this.images.get(imageId)?.path
    return path && existsSync(path) ? path : undefined
  }

  /** Answers `aterm-image://img/<id>` with the image's own bytes. */
  serve(url: string): Response {
    const id = new URL(url).pathname.replace(/^\//, '')
    const ref = this.images.get(id)
    const image = ref ? readImage(ref) : undefined
    if (!image) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(image.data), {
      headers: { 'content-type': image.mediaType, 'cache-control': 'max-age=31536000' }
    })
  }

  private drop(tabId: string): void {
    const followed = this.tabs.get(tabId)
    if (!followed) return
    for (const id of followed.imageIds) this.images.delete(id)
    this.tabs.delete(tabId)
  }

  /** Reads what was appended since the last time; `history` limits a first read to the tail. */
  private read(followed: Followed, history: boolean): TranscriptImage[] {
    const file = followed.file
    if (!file) return []
    const added: TranscriptImage[] = []
    let fd: number | undefined
    try {
      fd = openSync(file, 'r')
      const size = fstatSync(fd).size
      if (size < followed.offset) followed.offset = 0
      let from = followed.offset
      // Starting mid-file lands inside a line; the first one is skipped as cut.
      const skipFirst = history && size - from > HISTORY_BYTES
      if (skipFirst) from = size - HISTORY_BYTES
      let first = skipFirst
      followed.offset = scanLines(fd, from, size, (line, offset) => {
        if (first) {
          first = false
          return
        }
        added.push(...this.inspect(followed, file, line, offset))
      })
    } catch {
      // A file being rotated or removed — the next change event tries again.
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    return added
  }

  private inspect(followed: Followed, file: string, line: Buffer, offset: number): TranscriptImage[] {
    // Cheap tests first: most lines are neither, and a line can be megabytes long.
    if (line.includes('"tool_use"')) rememberToolUses(followed, line)
    if (!line.includes('"type":"image"')) return []

    const entry = parseJson<TranscriptLine>(line.toString('utf8'))
    if (entry?.type !== 'user' || entry.isSidechain || !Array.isArray(entry.message?.content)) return []
    const dimensions = entry.toolUseResult?.file?.dimensions

    const found: TranscriptImage[] = []
    const add = (block: number[], label: string, source: TranscriptImage['source'], path?: string): void => {
      const id = String(this.nextId++)
      this.images.set(id, { file, offset, length: line.length, block, path })
      followed.imageIds.push(id)
      found.push({
        id,
        url: `${IMAGE_SCHEME}://img/${id}`,
        label,
        source,
        hasFile: Boolean(path),
        width: dimensions?.displayWidth,
        height: dimensions?.displayHeight
      })
    }

    ;(entry.message.content as ContentBlock[]).forEach((block, i) => {
      if (isImage(block)) add([i], 'Pasted image', 'user')
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return
      const use = block.tool_use_id ? followed.toolUses.get(block.tool_use_id) : undefined
      if (block.tool_use_id) followed.toolUses.delete(block.tool_use_id)
      ;(block.content as ContentBlock[]).forEach((inner, j) => {
        if (isImage(inner)) add([i, j], use?.path ?? use?.name ?? 'Tool result', 'tool', use?.path)
      })
    })

    while (followed.imageIds.length > MAX_IMAGES) {
      const oldest = followed.imageIds.shift()
      if (oldest) this.images.delete(oldest)
    }
    return found
  }

  private emitImages(event: TabImagesEvent): void {
    this.emit('images', event)
  }
}

function isImage(block: ContentBlock): boolean {
  return block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string'
}

/** An assistant line's tool calls, by id — what a later tool result answers. */
function rememberToolUses(followed: Followed, line: Buffer): void {
  const entry = parseJson<{ type?: string; message?: { content?: unknown } }>(line.toString('utf8'))
  if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) return
  for (const block of entry.message.content as { type?: string; id?: string; name?: string; input?: { file_path?: unknown } }[]) {
    if (block?.type !== 'tool_use' || !block.id || !block.name) continue
    const path = typeof block.input?.file_path === 'string' ? block.input.file_path : undefined
    followed.toolUses.set(block.id, { name: block.name, path })
  }
}

/**
 * Hands every complete line in `[from, to)` to `onLine` with its offset, and returns
 * where the first incomplete one starts — the last line may still be half-written.
 */
function scanLines(fd: number, from: number, to: number, onLine: (line: Buffer, offset: number) => void): number {
  let carry: Buffer[] = []
  let lineStart = from
  let pos = from
  while (pos < to) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - pos))
    const n = readSync(fd, buffer, 0, buffer.length, pos)
    if (n <= 0) break
    let start = 0
    for (;;) {
      const nl = buffer.indexOf(10, start)
      if (nl < 0 || nl >= n) break
      const piece = buffer.subarray(start, nl)
      const line = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece
      carry = []
      if (line.length > 0) onLine(line, lineStart)
      start = nl + 1
      lineStart = pos + start
    }
    if (start < n) carry.push(buffer.subarray(start, n))
    pos += n
  }
  return lineStart
}

function readImage(ref: ImageRef): { data: Buffer; mediaType: string } | undefined {
  let fd: number | undefined
  try {
    fd = openSync(ref.file, 'r')
    const buffer = Buffer.allocUnsafe(ref.length)
    readSync(fd, buffer, 0, ref.length, ref.offset)
    const entry = parseJson<TranscriptLine>(buffer.toString('utf8'))
    let block = (entry?.message?.content as ContentBlock[] | undefined)?.[ref.block[0]]
    if (ref.block.length > 1) block = (block?.content as ContentBlock[] | undefined)?.[ref.block[1]]
    if (!block || !isImage(block)) return undefined
    return {
      data: Buffer.from(block.source!.data!, 'base64'),
      mediaType: block.source!.media_type ?? 'image/png'
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The transcript of a conversation, wherever Claude Code filed it — under the tab's
 * directory, under one of its worktrees, or under wherever a `/resume` came from.
 * One listing of the projects directory; nothing below it is read.
 */
function locate(conversationId: string): string | undefined {
  const root = projectsDir()
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const file = join(root, project, `${conversationId}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}
