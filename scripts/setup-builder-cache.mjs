/**
 * Places electron-builder's vendor binaries in its cache.
 *
 * Background: the `winCodeSign` archive contains macOS symlinks, and Windows
 * only allows creating symlinks with developer mode or administrator rights —
 * otherwise the extraction aborts and the installer build fails, even though a
 * Windows build needs no macOS artifact at all.
 *
 * The archive is therefore extracted here without the `darwin` branch. When
 * electron-builder runs afterwards it finds the finished folder and downloads
 * nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WIN_CODE_SIGN_VERSION = '2.6.0'

const cacheRoot = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
const signCache = join(cacheRoot, 'winCodeSign')
const target = join(signCache, `winCodeSign-${WIN_CODE_SIGN_VERSION}`)
const sevenZip = join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

if (existsSync(join(target, 'windows-10'))) {
  console.log('[setup-builder-cache] winCodeSign is already in the cache.')
  process.exit(0)
}

if (!existsSync(sevenZip)) {
  console.error('[setup-builder-cache] 7za.exe not found — run npm install first.')
  process.exit(1)
}

/** An aborted run leaves the archive behind under a random name. */
function findDownloadedArchive() {
  if (!existsSync(signCache)) return undefined
  const archives = readdirSync(signCache)
    .filter((name) => name.endsWith('.7z'))
    .map((name) => join(signCache, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return archives[0]
}

function download() {
  const url =
    'https://github.com/electron-userland/electron-builder-binaries/releases/download/' +
    `winCodeSign-${WIN_CODE_SIGN_VERSION}/winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`
  const out = join(signCache, `winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`)
  mkdirSync(signCache, { recursive: true })
  console.log('[setup-builder-cache] downloading winCodeSign …')
  // curl uses the system proxy; the built-in downloader does not do so reliably.
  const result = spawnSync('curl', ['-L', '--fail', '--silent', '--show-error', '-o', out, url], {
    stdio: 'inherit',
    shell: true
  })
  return result.status === 0 ? out : undefined
}

const archive = findDownloadedArchive() ?? download()
if (!archive) {
  console.error('[setup-builder-cache] could not obtain winCodeSign.')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const extract = spawnSync(
  `"${sevenZip}"`,
  ['x', '-bd', '-y', `"${archive}"`, `-o"${target}"`, '-xr!darwin'],
  { stdio: 'inherit', shell: true }
)

if (extract.status !== 0 || !existsSync(join(target, 'windows-10'))) {
  console.error('[setup-builder-cache] extraction failed.')
  process.exit(1)
}

// The half-extracted directories from aborted runs are only in the way.
for (const name of readdirSync(signCache)) {
  if (/^\d+$/.test(name)) rmSync(join(signCache, name), { recursive: true, force: true })
}

console.log(`[setup-builder-cache] winCodeSign ready at ${target}`)
