import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstallMode, UpdateCheck, UpdateProgress, UpdateResult } from '@shared/types'
import { fetchNewerReleases, type Release } from './releases'

/** How often a download reports progress at most. */
const PROGRESS_INTERVAL_MS = 100

/**
 * The flags electron-builder's own updater passes. `/S` runs the assisted installer
 * without a window; it then takes the install directory from the previous
 * installation's `InstallLocation`, so a directory the user chose is kept.
 * `--updated` shortens its wait for the running app and skips the "app is running"
 * question, `--force-run` starts aterm again once it is done. The installer ends any
 * `aterm.exe` of this user that is still around by then — a portable one included.
 */
const SILENT_INSTALL_ARGS = ['--updated', '/S', '--force-run']

/** Test hook: pretend to be this version, so a published release counts as newer. */
const VERSION_OVERRIDE = 'ATERM_UPDATE_FROM'

/** Newest first, from the last check that reached GitHub. */
let releases: Release[] = []
let download: Promise<UpdateResult> | undefined
/** The installer that was downloaded and whose hash matched — the only one ever run. */
let verified: { version: string; file: string } | undefined

export function installMode(): InstallMode {
  if (!app.isPackaged) return 'dev'
  // Set by electron-builder's portable launcher for the app it unpacks.
  if (process.env['PORTABLE_EXECUTABLE_FILE']) return 'portable'
  return 'installer'
}

function downloadDir(): string {
  return join(app.getPath('temp'), 'aterm-update')
}

/** Installers left over from earlier runs — the last update, or an abandoned one. */
export function cleanupDownloads(): void {
  try {
    rmSync(downloadDir(), { recursive: true, force: true })
  } catch {
    // A file still held by a running installer; the next start gets it.
  }
}

/** `undefined` when GitHub could not be asked, which says nothing about updates. */
export async function checkForUpdates(): Promise<UpdateCheck | undefined> {
  const current = process.env[VERSION_OVERRIDE] || app.getVersion()
  const found = await fetchNewerReleases(current)
  if (!found) return undefined
  // A download in flight keeps the list it started from, so what gets installed is
  // the version the renderer is showing.
  if (!download) releases = found
  return { current, mode: installMode(), releases: found.map((r) => r.info) }
}

/**
 * Downloads the newest release's installer and checks it against the SHA-256 GitHub
 * lists for the upload. Nothing is run that did not match. A second call while one
 * is running gets the same result.
 */
export function downloadUpdate(onProgress: (p: UpdateProgress) => void): Promise<UpdateResult> {
  download ??= fetchInstaller(onProgress).finally(() => {
    download = undefined
  })
  return download
}

async function fetchInstaller(onProgress: (p: UpdateProgress) => void): Promise<UpdateResult> {
  if (installMode() !== 'installer') return { ok: false, error: 'This copy of aterm cannot update itself.' }
  const release = releases[0]
  if (!release) return { ok: false, error: 'No update available.' }
  if (verified?.version === release.info.version) return { ok: true }

  const asset = release.installer
  if (!asset) return { ok: false, error: `Release ${release.info.version} has no installer.` }
  if (!asset.sha256) {
    return { ok: false, error: `Release ${release.info.version} lists no checksum for its installer.` }
  }

  const dir = downloadDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `aterm-Setup-${release.info.version}.exe`)
  const part = `${file}.part`

  try {
    const res = await net.fetch(asset.url, { headers: { 'User-Agent': `aterm/${app.getVersion()}` } })
    if (!res.ok || !res.body) return { ok: false, error: `Download failed (HTTP ${res.status}).` }

    const total = Number(res.headers.get('content-length')) || asset.size
    const hash = createHash('sha256')
    const out = await open(part, 'w')
    let received = 0
    let lastReport = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        await out.write(value)
        received += value.byteLength
        if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = Date.now()
          onProgress({ received, total })
        }
      }
    } finally {
      await out.close()
    }
    onProgress({ received, total })

    if (hash.digest('hex') !== asset.sha256) {
      await rm(part, { force: true })
      return { ok: false, error: 'The downloaded installer does not match its checksum.' }
    }
    await rename(part, file)
    verified = { version: release.info.version, file }
    return { ok: true }
  } catch (err) {
    await rm(part, { force: true }).catch(() => undefined)
    return { ok: false, error: `Download failed: ${(err as Error).message}` }
  }
}

/**
 * Starts the verified installer and quits. aterm quits the normal way — state is
 * saved and every tab process ended in `before-quit` — while the installer waits for
 * it and starts the new version afterwards. The quit only happens once the installer
 * process exists: a failed start must not take aterm down with nothing to replace it.
 */
export function installUpdate(): Promise<UpdateResult> {
  if (installMode() !== 'installer' || !verified || !existsSync(verified.file)) {
    return Promise.resolve({ ok: false, error: 'No verified installer to run.' })
  }
  const child = spawn(verified.file, SILENT_INSTALL_ARGS, { detached: true, stdio: 'ignore' })
  return new Promise((resolve) => {
    child.once('error', (err) => resolve({ ok: false, error: `Installer did not start: ${err.message}` }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
      app.quit()
    })
  })
}
