import { app, net } from 'electron'
import type { ReleaseInfo } from '@shared/types'

const RELEASES_URL = 'https://api.github.com/repos/cgri/aterm/releases?per_page=20'

/**
 * The installer of a release. GitHub replaces the spaces of an uploaded file name
 * with dots, so `aterm Setup 1.9.0.exe` is listed as `aterm.Setup.1.9.0.exe`.
 */
const INSTALLER_ASSET = /^aterm[ .]Setup[ .].+\.exe$/

export interface InstallerAsset {
  url: string
  size: number
  /** Hex SHA-256 from GitHub's `digest`. Missing only on very old uploads. */
  sha256?: string
}

/** What the main process keeps about a release; only `info` reaches the renderer. */
export interface Release {
  info: ReleaseInfo
  installer?: InstallerAsset
}

interface GitHubAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

interface GitHubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

/**
 * Published releases newer than `current`, newest first — or `undefined` when GitHub
 * could not be asked (offline, rate limit, proxy). The unauthenticated API is enough
 * because the repository is public. `net.fetch` rather than Node's fetch: it goes
 * through Chromium's network stack, which honours the system proxy.
 */
export async function fetchNewerReleases(current: string): Promise<Release[] | undefined> {
  let list: GitHubRelease[]
  try {
    const res = await net.fetch(RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `aterm/${app.getVersion()}`
      }
    })
    if (!res.ok) return undefined
    list = (await res.json()) as GitHubRelease[]
    if (!Array.isArray(list)) return undefined
  } catch {
    return undefined
  }

  return list
    .filter((r) => !r.draft && !r.prerelease)
    .map(toRelease)
    .filter((r): r is Release => r !== undefined && compareVersions(r.info.version, current) > 0)
    .sort((a, b) => compareVersions(b.info.version, a.info.version))
}

function toRelease(r: GitHubRelease): Release | undefined {
  const version = r.tag_name.replace(/^v/, '')
  if (!parseVersion(version)) return undefined
  const asset = r.assets.find((a) => INSTALLER_ASSET.test(a.name))
  return {
    info: {
      version,
      title: r.name || `aterm ${version}`,
      notes: r.body ?? '',
      url: r.html_url,
      publishedAt: r.published_at ?? ''
    },
    installer: asset && {
      url: asset.browser_download_url,
      size: asset.size,
      sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : undefined
    }
  }
}

function parseVersion(version: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return m ? m.slice(1).map(Number) : undefined
}

/** Plain `x.y.z` ordering. Anything else sorts as `0.0.0`, i.e. never newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0]
  const pb = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}
