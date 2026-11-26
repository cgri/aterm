/**
 * Turns Jira wiki markup into DOM, for a text that is going to a Jira that speaks it
 * (Server and Data Center). Read as Markdown it falls apart: `# ` is a numbered list
 * there, not a heading, and `{{x}}` is code. Like the plan renderer, every piece of text
 * goes in through `textContent`. Only what a ticket or comment commonly uses is drawn;
 * anything else stays as written, which is what the user should see then anyway.
 */
export function renderJira(markup: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = markup.replace(/\r\n?/g, '\n').split('\n')

  let paragraph: string[] = []
  /** The open lists, outermost first; `#` numbered, `*` or `-` bulleted. */
  let lists: { el: HTMLOListElement | HTMLUListElement; marker: string }[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const p = document.createElement('p')
    paragraph.forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'))
      appendJiraInline(p, line)
    })
    out.appendChild(p)
    paragraph = []
  }
  const closeLists = (): void => {
    if (lists.length) out.appendChild(lists[0].el)
    lists = []
  }
  const flushAll = (): void => {
    flushParagraph()
    closeLists()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // {code}, {code:java}, {noformat}: verbatim up to the closing tag.
    const block = /^\s*\{(code|noformat)(?::[^}]*)?\}(.*)$/.exec(line)
    if (block) {
      flushAll()
      const close = `{${block[1]}}`
      const body: string[] = []
      let rest = block[2]
      for (;;) {
        const end = rest.indexOf(close)
        if (end >= 0) {
          body.push(rest.slice(0, end))
          break
        }
        body.push(rest)
        if (++i >= lines.length) break
        rest = lines[i]
      }
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = body.join('\n').replace(/^\n+|\n+$/g, '')
      pre.appendChild(code)
      out.appendChild(pre)
      continue
    }

    // {quote} ... {quote}
    if (/^\s*\{quote\}/.test(line)) {
      flushAll()
      const body: string[] = []
      let rest = line.replace(/^\s*\{quote\}/, '')
      for (;;) {
        const end = rest.indexOf('{quote}')
        if (end >= 0) {
          body.push(rest.slice(0, end))
          break
        }
        body.push(rest)
        if (++i >= lines.length) break
        rest = lines[i]
      }
      out.appendChild(quote(body.join('\n')))
      continue
    }

    if (!line.trim()) {
      flushAll()
      continue
    }

    const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const h = document.createElement(`h${Math.min(Number(heading[1]), 4)}`)
      appendJiraInline(h, heading[2])
      out.appendChild(h)
      continue
    }

    const bq = /^\s*bq\.\s+(.*)$/.exec(line)
    if (bq) {
      flushAll()
      out.appendChild(quote(bq[1]))
      continue
    }

    if (/^\s*-{4,}\s*$/.test(line)) {
      flushAll()
      out.appendChild(document.createElement('hr'))
      continue
    }

    if (/^\s*\|/.test(line)) {
      flushAll()
      const rows: string[] = [line]
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i])
      out.appendChild(table(rows))
      continue
    }

    // `* a`, `** nested`, `# one`, `#* mixed`; `-` only on the top level, as in Jira.
    const item = /^\s*([*#]+|-)\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      const markers = item[1] === '-' ? '*' : item[1]
      // Keep the open lists that this item's markers still agree with.
      let keep = 0
      while (keep < lists.length && keep < markers.length && lists[keep].marker === markers[keep]) keep++
      if (keep === 0) closeLists()
      else lists.length = keep
      while (lists.length < markers.length) {
        const marker = markers[lists.length]
        const el = document.createElement(marker === '#' ? 'ol' : 'ul')
        const parent = lists[lists.length - 1]
        if (parent) {
          const host = parent.el.lastElementChild ?? parent.el.appendChild(document.createElement('li'))
          host.appendChild(el)
        }
        lists.push({ el, marker })
      }
      const li = document.createElement('li')
      appendJiraInline(li, item[2])
      lists[lists.length - 1].el.appendChild(li)
      continue
    }

    // Any other line ends a list, as in Jira; inside a paragraph a line break is kept.
    closeLists()
    paragraph.push(line.trim())
  }
  flushAll()
  return out
}

function quote(text: string): HTMLQuoteElement {
  const el = document.createElement('blockquote')
  for (const part of text.replace(/^\n+|\n+$/g, '').split(/\n{2,}/)) {
    const p = document.createElement('p')
    part.split('\n').forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'))
      appendJiraInline(p, line)
    })
    el.appendChild(p)
  }
  return el
}

function table(rows: string[]): HTMLTableElement {
  const el = document.createElement('table')
  const body = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const { header, text } of cells(row.trim())) {
      const cell = document.createElement(header ? 'th' : 'td')
      appendJiraInline(cell, text)
      tr.appendChild(cell)
    }
    body.appendChild(tr)
  }
  el.appendChild(body)
  return el
}

/**
 * `||` opens a header cell, `|` a plain one, and the separator closing the row opens
 * nothing. A `|` inside `[text|url]` is the link's, not the table's.
 */
function cells(row: string): { header: boolean; text: string }[] {
  const out: { header: boolean; text: string }[] = []
  let i = 0
  while (i < row.length && row[i] === '|') {
    const header = row[i + 1] === '|'
    i += header ? 2 : 1
    let depth = 0
    let end = i
    for (; end < row.length; end++) {
      if (row[end] === '[') depth++
      else if (row[end] === ']') depth = Math.max(0, depth - 1)
      else if (row[end] === '|' && depth === 0) break
    }
    const text = row.slice(i, end).trim()
    if (end < row.length || text) out.push({ header, text })
    i = end
  }
  return out
}

/**
 * Inline markup. A `*`, `_`, `-` or `+` pair only counts at word boundaries, as in Jira,
 * so `a-b-c` and file_names_like_this stay as they are.
 */
const INLINE = new RegExp(
  [
    /\{\{(.+?)\}\}/.source, // 1 monospace
    /\[([^\]|]+)\|(https?:\/\/[^\]\s]+)\]/.source, // 2, 3 [text|url]
    /\[(https?:\/\/[^\]\s]+)\]/.source, // 4 [url]
    /(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/.source, // 5 bold
    /(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/.source, // 6 italic
    /(?<![\w-])-(?=\S)(.+?)(?<=\S)-(?![\w-])/.source, // 7 strikethrough
    /(?<![\w+])\+(?=\S)(.+?)(?<=\S)\+(?![\w+])/.source, // 8 underline
    /\{color(?::[^}]*)?\}(.*?)\{color\}/.source, // 9 colour, drawn plain
    /\[~([^\]]+)\]/.source // 10 a mention
  ].join('|'),
  'g'
)

export function appendJiraInline(parent: HTMLElement, text: string): void {
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0
    if (index > last) parent.append(text.slice(last, index))
    last = index + m[0].length

    if (m[1] !== undefined) {
      const code = document.createElement('code')
      code.textContent = m[1]
      parent.appendChild(code)
    } else if (m[2] !== undefined || m[4] !== undefined) {
      // A new window, never a navigation, as in the release notes.
      const a = document.createElement('a')
      a.href = m[3] ?? m[4]
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.textContent = m[2] ?? m[4]
      parent.appendChild(a)
    } else if (m[10] !== undefined) {
      parent.append(`@${m[10]}`)
    } else {
      const tag = m[5] !== undefined ? 'strong' : m[6] !== undefined ? 'em' : m[7] !== undefined ? 's' : m[8] !== undefined ? 'u' : 'span'
      const el = document.createElement(tag)
      appendJiraInline(el, m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9])
      parent.appendChild(el)
    }
  }
  if (last < text.length) parent.append(text.slice(last))
}
