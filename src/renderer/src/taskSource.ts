/**
 * Where a task came from, read out of what the user typed or pasted: an issue, PR or MR
 * link, a Jira-style ticket key, or any other link. String rules only — nothing is fetched,
 * so a task made from a bare link is titled after the link until a session renames it
 * (`task_update` takes a `title`).
 */
export interface ParsedSource {
  /** The link or key itself, as stored on the task. */
  source: string
  /** Short, for the chip on a task: `GH #77`, `!12`, `OPS-2211`. */
  label: string
  /** Longer, for saying what was recognised: `GitHub issue cgri/aterm#77`. */
  description: string
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/i
const KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/

export function parseSource(text: string): ParsedSource | undefined {
  const url = URL_PATTERN.exec(text)?.[0]?.replace(/[).,;]+$/, '')
  if (url) return describeUrl(url)
  const key = KEY_PATTERN.exec(text)?.[0]
  return key ? { source: key, label: key, description: `Ticket ${key}` } : undefined
}

/** What the user typed, less the link or key: the title, if there is any left. */
export function titleWithout(text: string, source: ParsedSource | undefined): string {
  if (!source) return text.trim()
  return text
    .replace(source.source, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
}

export function describeSource(source: string): ParsedSource {
  return parseSource(source) ?? { source, label: source.slice(0, 24), description: source }
}

/** Whether a stored source can be opened in the browser. */
export function isLink(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

function describeUrl(url: string): ParsedSource {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { source: url, label: 'Link', description: url }
  }
  const path = parsed.pathname.replace(/\/+$/, '')

  const gh = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/.exec(path)
  if (parsed.hostname === 'github.com' && gh) {
    const [, owner, repo, kind, n] = gh
    return {
      source: url,
      label: `GH #${n}`,
      description: `GitHub ${kind === 'pull' ? 'PR' : 'issue'} ${owner}/${repo}#${n}`
    }
  }

  const gl = /^\/(.+?)\/-\/(issues|merge_requests)\/(\d+)/.exec(path)
  if (gl) {
    const [, project, kind, n] = gl
    const mr = kind === 'merge_requests'
    return { source: url, label: mr ? `!${n}` : `#${n}`, description: `${mr ? 'MR' : 'Issue'} ${project}${mr ? '!' : '#'}${n}` }
  }

  const key = KEY_PATTERN.exec(path)?.[0]
  if (key) return { source: url, label: key, description: `Ticket ${key}` }

  return { source: url, label: parsed.hostname.replace(/^www\./, ''), description: url }
}
