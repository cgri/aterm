/**
 * Turns release notes into DOM, for the subset of Markdown they are written in:
 * headings, `-` lists, paragraphs, `**bold**`, `*emphasis*`, `` `code` `` and
 * links. Every piece of text goes in through `textContent`, never `innerHTML`, so
 * whatever a release says cannot become markup here.
 *
 * The `## Downloads` section is left out: it names the files on the GitHub page,
 * which is not where the reader is.
 */
export function renderReleaseNotes(markdown: string): DocumentFragment {
  const out = document.createDocumentFragment()
  let paragraph: string[] = []
  let list: HTMLUListElement | undefined
  let item: string[] = []
  let skipping = false

  const flushItem = (): void => {
    if (!item.length || !list) return
    const li = document.createElement('li')
    appendInline(li, item.join(' '))
    list.appendChild(li)
    item = []
  }
  const flush = (): void => {
    if (paragraph.length) {
      const p = document.createElement('p')
      appendInline(p, paragraph.join(' '))
      out.appendChild(p)
      paragraph = []
    }
    flushItem()
    if (list) out.appendChild(list)
    list = undefined
  }

  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()

    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      skipping = heading[1].trim().toLowerCase() === 'downloads'
      if (!skipping) {
        const h = document.createElement('h4')
        appendInline(h, heading[1].trim())
        out.appendChild(h)
      }
      continue
    }
    if (skipping) continue

    if (!line.trim()) {
      flush()
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (paragraph.length) flush()
      flushItem()
      list ??= document.createElement('ul')
      item = [bullet[1]]
      continue
    }

    // A line that follows a list item continues it; anything else is a paragraph.
    if (item.length) item.push(line.trim())
    else paragraph.push(line.trim())
  }
  flush()
  return out
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*]*?)\*/g

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0
    if (index > last) parent.append(text.slice(last, index))
    last = index + m[0].length

    if (m[1] !== undefined) {
      const strong = document.createElement('strong')
      appendInline(strong, m[1])
      parent.appendChild(strong)
    } else if (m[2] !== undefined) {
      const code = document.createElement('code')
      code.textContent = m[2]
      parent.appendChild(code)
    } else if (m[3] !== undefined) {
      // A new window, never a navigation: the window-open handler hands it to the
      // browser, while a plain link would replace aterm's own page.
      const a = document.createElement('a')
      a.href = m[4]
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.textContent = m[3]
      parent.appendChild(a)
    } else if (m[5] !== undefined) {
      const em = document.createElement('em')
      appendInline(em, m[5])
      parent.appendChild(em)
    }
  }
  if (last < text.length) parent.append(text.slice(last))
}
