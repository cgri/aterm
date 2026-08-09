/**
 * Baut node-pty gegen die installierte Electron-Fassung und lädt bei Bedarf das
 * Electron-Binary nach.
 *
 * Drei Eigenheiten, über die der Standardweg (`electron-builder install-app-deps`)
 * auf gehärteten Windows-Arbeitsplätzen stolpert, sind hier abgefangen:
 *
 * 1. `NoDefaultCurrentDirectoryInExePath=1` — dann findet cmd das Skript
 *    `GetCommitHash.bat` von winpty nicht mehr, und die gyp-Konfiguration bricht ab.
 * 2. Fehlende Spectre-mitigierte MSVC-Bibliotheken — node-pty verlangt sie per
 *    Projekteinstellung (MSB8040). Sind sie nicht installiert, baut das Skript
 *    ohne sie und sagt das deutlich.
 * 3. Electron lädt sein Binary direkt von github.com; hinter einem Proxy scheitert
 *    das still. Der Download läuft deshalb notfalls über curl, das den
 *    System-Proxy nutzt.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.cwd()
const ptyDir = join(root, 'node_modules', 'node-pty')
const electronDir = join(root, 'node_modules', 'electron')

// Diese Härtung bricht den winpty-Build — nur für die Kindprozesse hier abschalten.
const env = { ...process.env }
delete env.NoDefaultCurrentDirectoryInExePath

function run(file, args, opts = {}) {
  const result = spawnSync(file, args, {
    stdio: 'inherit',
    shell: true,
    env,
    ...opts
  })
  return result.status === 0
}

function electronVersion() {
  return JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version
}

function ensureElectronBinary(version) {
  if (existsSync(join(electronDir, 'dist', 'electron.exe'))) return true

  console.log(`[setup-native] lade Electron ${version} …`)
  if (run(process.execPath, ['install.js'], { cwd: electronDir })) return true

  // Fallback: curl kennt den System-Proxy, @electron/get nicht zuverlässig.
  console.log('[setup-native] Direktdownload fehlgeschlagen, versuche es über curl …')
  const zip = join(tmpdir(), `electron-v${version}-win32-x64.zip`)
  const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-win32-x64.zip`
  if (!run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', `"${zip}"`, url])) return false

  const dist = join(electronDir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  if (!run('tar', ['-xf', `"${zip}"`, '-C', `"${dist}"`])) return false
  writeFileSync(join(electronDir, 'path.txt'), 'electron.exe')
  return existsSync(join(dist, 'electron.exe'))
}

function hasSpectreLibs() {
  const base = 'C:\\Program Files\\Microsoft Visual Studio\\2022'
  for (const edition of ['Enterprise', 'Professional', 'Community', 'BuildTools']) {
    const tools = join(base, edition, 'VC', 'Tools', 'MSVC')
    if (!existsSync(tools)) continue
    // Eine einzige vorhandene spectre-Variante genügt MSBuild.
    for (const version of readdirSync(tools)) {
      if (existsSync(join(tools, version, 'lib', 'spectre'))) return true
    }
  }
  return false
}

function findMsbuild() {
  const base = 'C:\\Program Files\\Microsoft Visual Studio\\2022'
  for (const edition of ['Enterprise', 'Professional', 'Community', 'BuildTools']) {
    const exe = join(base, edition, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
    if (existsSync(exe)) return exe
  }
  return undefined
}

function buildPty(version) {
  const nodeGyp = join(root, 'node_modules', '.bin', 'node-gyp.cmd')
  const common = [
    `--target=${version}`,
    '--dist-url=https://electronjs.org/headers',
    '--arch=x64'
  ]

  if (!run(nodeGyp, ['configure', ...common], { cwd: ptyDir })) return false

  // node-gyp reicht keine /p:-Eigenschaften durch, deshalb hier direkt MSBuild.
  if (!hasSpectreLibs()) {
    const msbuild = findMsbuild()
    if (!msbuild) {
      console.error('[setup-native] MSBuild nicht gefunden.')
      return false
    }
    console.warn(
      '[setup-native] Spectre-mitigierte MSVC-Bibliotheken fehlen — es wird ohne sie gebaut.\n' +
        '               Für einen mitigierten Build in Visual Studio Installer die Komponente\n' +
        '               "MSVC v143 – VS 2022 C++ x64/x86 Spectre-mitigated libs" nachinstallieren.'
    )
    return run(`"${msbuild}"`, [
      `"${join(ptyDir, 'build', 'binding.sln')}"`,
      '/p:Configuration=Release',
      '/p:Platform=x64',
      '/p:SpectreMitigation=false',
      '/clp:Verbosity=minimal',
      '/nologo'
    ])
  }

  return run(nodeGyp, ['build', ...common], { cwd: ptyDir })
}

const version = electronVersion()

if (!ensureElectronBinary(version)) {
  console.error('[setup-native] Electron-Binary konnte nicht bereitgestellt werden.')
  process.exit(1)
}

if (existsSync(join(ptyDir, 'build', 'Release', 'pty.node')) && !process.argv.includes('--force')) {
  console.log('[setup-native] node-pty ist bereits gebaut (--force erzwingt den Neubau).')
  process.exit(0)
}

if (!buildPty(version)) {
  console.error('[setup-native] node-pty konnte nicht gebaut werden.')
  process.exit(1)
}

console.log('[setup-native] fertig.')
