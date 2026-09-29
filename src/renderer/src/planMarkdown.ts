import { appendInline } from './releaseNotes'

/**
 * Turns a plan into DOM. Plans use more Markdown than release notes do — numbered and
 * nested lists, fenced code, tables, quotes — so this is a block parser of its own,
 * with the inline half shared. Like the release notes, every piece of text goes in
 * through `textContent`: a plan cannot become markup here.
 */
export function renderPlan(markdown: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')

  let paragraph: string[] = []
  let quote: string[] = []
  const lists: ListFrame[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const p = document.createElement('p')
    appendInline(p, paragraph.join(' '))
    out.appendChild(p)
    paragraph = []
  }
  const flushQuote = (): void => {
    if (!quote.length) return
    const block = document.createElement('blockquote')
    for (const text of quote.join('\n').split(/\n{2,}/)) {
      const p = document.createElement('p')
      appendInline(p, text.replace(/\n/g, ' '))
      block.appendChild(p)
    }
    out.appendChild(block)
    quote = []
  }
  const closeLists = (downTo = 0): void => {
    while (lists.length > downTo) {
      const frame = lists.pop()!
      flushItem(frame)
      const parent = lists[lists.length - 1]
      if (parent?.item) parent.item.appendChild(frame.el)
      else out.appendChild(frame.el)
    }
  }
  const flushAll = (): void => {
    flushParagraph()
    flushQuote()
    closeLists()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.length - line.trimStart().length

    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) {
        body.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)))
      }
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = body.join('\n')
      pre.appendChild(code)
      flushParagraph()
      flushQuote()
      // Indented under a list item, it belongs to that item.
      const top = lists[lists.length - 1]
      if (top?.item && indent > top.indent) {
        flushItem(top)
        top.item.appendChild(pre)
      } else {
        closeLists()
        out.appendChild(pre)
      }
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushQuote()
      // A list goes on across a blank line; what comes next decides.
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushAll()
      const h = document.createElement(`h${Math.min(heading[1].length, 4)}`)
      appendInline(h, heading[2])
      out.appendChild(h)
      continue
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll()
      out.appendChild(document.createElement('hr'))
      continue
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushAll()
      const rows: string[] = [line]
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i])
      i--
      out.appendChild(table(rows))
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted) {
      flushParagraph()
      closeLists()
      quote.push(quoted[1])
      continue
    }

    const bullet = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      flushQuote()
      const ordered = bullet[3] !== undefined
      while (lists.length && lists[lists.length - 1].indent > indent) closeLists(lists.length - 1)
      let top = lists[lists.length - 1]
      if (top && top.indent === indent && top.ordered !== ordered) {
        closeLists(lists.length - 1)
        top = lists[lists.length - 1]
      }
      if (!top || indent > top.indent) {
        if (top) flushItem(top)
        const el = document.createElement(ordered ? 'ol' : 'ul')
        if (ordered && bullet[3] !== '1') (el as HTMLOListElement).start = Number(bullet[3])
        top = { el, indent, ordered, text: [] }
        lists.push(top)
      } else {
        flushItem(top)
      }
      top.item = document.createElement('li')
      top.el.appendChild(top.item)
      top.text = [bullet[4]]
      continue
    }

    // Text under a list item continues it when indented, or right after it.
    const top = lists[lists.length - 1]
    if (top?.item && (indent > top.indent || lines[i - 1]?.trim())) {
      if (!top.text.length && top.item.childNodes.length) top.pending = true
      top.text.push(line.trim())
      continue
    }

    closeLists()
    flushQuote()
    paragraph.push(line.trim())
  }
  flushAll()
  return out
}

interface ListFrame {
  el: HTMLOListElement | HTMLUListElement
  indent: number
  ordered: boolean
  item?: HTMLLIElement
  text: string[]
  /** Text that follows a nested list or a code block, and needs a block of its own. */
  pending?: boolean
}

function flushItem(frame: ListFrame): void {
  if (!frame.item || !frame.text.length) return
  if (frame.pending) {
    const p = document.createElement('p')
    appendInline(p, frame.text.join(' '))
    frame.item.appendChild(p)
  } else {
    appendInline(frame.item, frame.text.join(' '))
  }
  frame.text = []
  frame.pending = false
}

function table(rows: string[]): HTMLTableElement {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const el = document.createElement('table')
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const text of cells(rows[0])) {
    const th = document.createElement('th')
    appendInline(th, text)
    headRow.appendChild(th)
  }
  head.appendChild(headRow)
  el.appendChild(head)

  const body = document.createElement('tbody')
  for (const row of rows.slice(1)) {
    const tr = document.createElement('tr')
    for (const text of cells(row)) {
      const td = document.createElement('td')
      appendInline(td, text)
      tr.appendChild(td)
    }
    body.appendChild(tr)
  }
  el.appendChild(body)
  return el
}
