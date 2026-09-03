/**
 * Builds node-pty against the installed Electron version and fetches the
 * Electron binary when it is missing.
 *
 * Three quirks that trip up the standard path (`electron-builder
 * install-app-deps`) on hardened Windows machines are handled here:
 *
 * 1. `NoDefaultCurrentDirectoryInExePath=1` — cmd can then no longer find
 *    winpty's `GetCommitHash.bat`, and the gyp configure step aborts.
 * 2. Missing Spectre-mitigated MSVC libraries — node-pty requires them through a
 *    project setting (MSB8040). When they are absent this script builds without
 *    them and says so clearly.
 * 3. Electron downloads its binary straight from github.com, which fails
 *    silently behind a proxy. The download therefore falls back to curl, which
 *    honours the system proxy.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.cwd()
const ptyDir = join(root, 'node_modules', 'node-pty')
const electronDir = join(root, 'node_modules', 'electron')

// This hardening breaks the winpty build — disable it for the child processes only.
const env = { ...process.env }
delete env.NoDefaultCurrentDirectoryInExePath

/**
 * Everything here runs through `shell: true`, because node-gyp is a `.cmd` and
 * Node refuses to spawn one without a shell. cmd.exe then splits the line on
 * whitespace and eats its own metacharacters, so each part has to arrive quoted —
 * the command itself included. That is not a corner case: `process.execPath` is
 * `C:\Program Files\nodejs\node.exe` on a default install, and unquoted it becomes
 * the command `C:\Program`, which cmd cannot find.
 */
const NEEDS_QUOTES = /[\s&|<>^()]/

function quote(part) {
  return NEEDS_QUOTES.test(part) ? `"${part}"` : part
}

function run(file, args, opts = {}) {
  const result = spawnSync(quote(file), args.map(quote), {
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

/**
 * Windows' own tar, by full path rather than by name. Git for Windows puts GNU
 * tar 1.32 on the PATH, which reads the colon in `C:\…` as a remote host and
 * fails with "Cannot connect to C: resolve failed" — so whether the extraction
 * works would depend on which shell `npm install` happened to run from.
 */
function bsdtar() {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(system32) ? system32 : 'tar'
}

function ensureElectronBinary(version) {
  if (existsSync(join(electronDir, 'dist', 'electron.exe'))) return true

  console.log(`[setup-native] downloading Electron ${version} …`)
  if (run(process.execPath, ['install.js'], { cwd: electronDir })) return true

  // Fallback: curl knows the system proxy, @electron/get does not reliably.
  console.log('[setup-native] direct download failed, trying curl …')
  const zip = join(tmpdir(), `electron-v${version}-win32-x64.zip`)
  const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-win32-x64.zip`
  if (!run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', zip, url])) return false

  const dist = join(electronDir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  if (!run(bsdtar(), ['-xf', zip, '-C', dist])) return false
  writeFileSync(join(electronDir, 'path.txt'), 'electron.exe')
  return existsSync(join(dist, 'electron.exe'))
}

function hasSpectreLibs() {
  const base = 'C:\\Program Files\\Microsoft Visual Studio\\2022'
  for (const edition of ['Enterprise', 'Professional', 'Community', 'BuildTools']) {
    const tools = join(base, edition, 'VC', 'Tools', 'MSVC')
    if (!existsSync(tools)) continue
    // A single spectre variant being present is enough for MSBuild.
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

  // node-gyp does not pass /p: properties through, so call MSBuild directly.
  if (!hasSpectreLibs()) {
    const msbuild = findMsbuild()
    if (!msbuild) {
      console.error('[setup-native] MSBuild not found.')
      return false
    }
    console.warn(
      '[setup-native] Spectre-mitigated MSVC libraries are missing — building without them.\n' +
        '               For a mitigated build, install the component\n' +
        '               "MSVC v143 – VS 2022 C++ x64/x86 Spectre-mitigated libs"\n' +
        '               in the Visual Studio Installer.'
    )
    return run(msbuild, [
      join(ptyDir, 'build', 'binding.sln'),
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
  console.error('[setup-native] could not provide the Electron binary.')
  process.exit(1)
}

if (existsSync(join(ptyDir, 'build', 'Release', 'pty.node')) && !process.argv.includes('--force')) {
  console.log('[setup-native] node-pty is already built (--force rebuilds it).')
  process.exit(0)
}

if (!buildPty(version)) {
  console.error('[setup-native] could not build node-pty.')
  process.exit(1)
}

console.log('[setup-native] done.')
