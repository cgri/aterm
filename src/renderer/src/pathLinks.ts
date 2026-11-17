import type { IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/**
 * File paths in a terminal's text, opened with Ctrl+click. A plain click stays what it
 * is everywhere else: a selection, or a click the program in the tab reads itself.
 *
 * Absolute paths (`C:\…`, `\\server\…`), `~/…` and relative paths with at least one
 * separator (`src/main/index.ts`) are candidates; only those main finds on disk become
 * links, so a word that merely looks like a path is never underlined. A trailing
 * `:line` or `:line:col`, as compilers and Claude Code write it, is not part of the path.
 * A path with spaces in it is not found — there is no telling where it ends.
 */

export interface PathLinkHost {
  /** The absolute path each candidate names on disk, or undefined where none exists. */
  resolve(candidates: string[]): Promise<(string | undefined)[]>
  open(path: string): void
}

// Not in the middle of a word or a URL: `https://host/x` holds `s://host/x`.
const PATH =
  /(?<![\w:/\\.~-])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|~[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[^\s"'`<>|*?(){}[\]]*/g
// Punctuation that ends a sentence or closes a quote, not a path.
const TRAILING = /[.,;:!'"`)\]}]+$/
const LOCATION = /:\d+(?::\d+)?$/

interface LogicalLine {
  text: string
  /** The cell each character of `text` was read from, 1-based as links want it. */
  cells: IBufferCellPosition[]
}

/** A buffer line together with the lines xterm.js wrapped it onto. */
function logicalLine(term: Terminal, y: number): LogicalLine {
  const buffer = term.buffer.active
  let first = y
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let last = y
  while (buffer.getLine(last + 1)?.isWrapped) last++

  let text = ''
  const cells: IBufferCellPosition[] = []
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)
    if (!line) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (const ch of chars) {
        text += ch
        cells.push({ x: x + 1, y: row + 1 })
      }
    }
  }
  return { text, cells }
}

export function pathLinkProvider(term: Terminal, host: PathLinkHost): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { text, cells } = logicalLine(term, y - 1)
      const found: { start: number; end: number; candidate: string }[] = []
      for (const match of text.matchAll(PATH)) {
        const raw = match[0].replace(TRAILING, '')
        const candidate = raw.replace(LOCATION, '')
        if (candidate.length < 3) continue
        const start = match.index ?? 0
        found.push({ start, end: start + raw.length - 1, candidate })
      }
      if (found.length === 0) return callback(undefined)

      void host.resolve(found.map((f) => f.candidate)).then((resolved) => {
        const links: ILink[] = []
        found.forEach((f, i) => {
          const path = resolved[i]
          if (!path) return
          links.push({
            range: { start: cells[f.start], end: cells[f.end] },
            text: path,
            decorations: { underline: true, pointerCursor: true },
            activate: (ev) => {
              if (ev.ctrlKey) host.open(path)
            }
          })
        })
        callback(links.length > 0 ? links : undefined)
      }, () => callback(undefined))
    }
  }
}
