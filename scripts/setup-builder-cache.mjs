/**
 * Legt die Vendor-Binaries von electron-builder im Cache ab.
 *
 * Hintergrund: Das Archiv `winCodeSign` enthält macOS-Symlinks. Windows lässt
 * das Anlegen von Symlinks nur mit Entwicklermodus oder Administratorrechten zu
 * — sonst bricht das Entpacken ab und der Installer-Build scheitert, obwohl
 * für einen Windows-Build kein einziges macOS-Artefakt gebraucht wird.
 *
 * Deshalb wird das Archiv hier ohne den `darwin`-Zweig entpackt. Läuft
 * electron-builder danach, findet es den fertigen Ordner vor und lädt nichts nach.
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
  console.log('[setup-builder-cache] winCodeSign liegt bereits im Cache.')
  process.exit(0)
}

if (!existsSync(sevenZip)) {
  console.error('[setup-builder-cache] 7za.exe nicht gefunden — zuerst npm install ausführen.')
  process.exit(1)
}

/** Ein abgebrochener Lauf hinterlässt das Archiv unter einem zufälligen Namen. */
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
  console.log('[setup-builder-cache] lade winCodeSign …')
  // curl nutzt den System-Proxy; der eingebaute Downloader tut das nicht zuverlässig.
  const result = spawnSync('curl', ['-L', '--fail', '--silent', '--show-error', '-o', out, url], {
    stdio: 'inherit',
    shell: true
  })
  return result.status === 0 ? out : undefined
}

const archive = findDownloadedArchive() ?? download()
if (!archive) {
  console.error('[setup-builder-cache] winCodeSign konnte nicht beschafft werden.')
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
  console.error('[setup-builder-cache] Entpacken fehlgeschlagen.')
  process.exit(1)
}

// Die halb entpackten Verzeichnisse abgebrochener Läufe stören sonst nur.
for (const name of readdirSync(signCache)) {
  if (/^\d+$/.test(name)) rmSync(join(signCache, name), { recursive: true, force: true })
}

console.log(`[setup-builder-cache] winCodeSign bereit unter ${target}`)
