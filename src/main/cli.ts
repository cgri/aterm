import { statSync } from 'node:fs'

/** The switch Explorer's context-menu entry passes the folder in. */
const OPEN_DIR = '--open-dir'

/**
 * The directory a launch names, or `undefined` when it names none.
 *
 * An explicit switch rather than "the last argument that happens to be a
 * directory": under `electron-vite dev` the first argument is `.`, which is one,
 * and every dev start would open a stray tab.
 */
export function directoryFromArgv(argv: string[]): string | undefined {
  const raw = rawValue(argv)
  if (!raw) return undefined
  const dir = repairDriveRoot(raw)
  try {
    return statSync(dir).isDirectory() ? dir : undefined
  } catch {
    // Gone, unreachable, or not a path at all — start normally rather than let
    // PtyManager fall back to the home directory and open a tab nobody asked for.
    return undefined
  }
}

/**
 * `--open-dir=<path>` is the form the context menu uses, and the only one that
 * survives a hand-over to a running instance: `second-instance` reports
 * Chromium's re-serialised command line, which sorts every switch ahead of the
 * bare arguments, so a path passed as the next argument no longer follows the
 * switch it belongs to. The separate form is still read for a launch by hand —
 * but never across a switch, which is what that reordering leaves behind.
 */
function rawValue(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith(`${OPEN_DIR}=`)) return arg.slice(OPEN_DIR.length + 1)
    if (arg !== OPEN_DIR) continue
    const next = argv[i + 1]
    return next && !next.startsWith('-') ? next : undefined
  }
  return undefined
}

/**
 * Explorer expands the registry command to `--open-dir="C:\"` for a drive root,
 * and `CommandLineToArgvW` reads that `\"` as an escaped quote — so the argument
 * arrives as `C:"`. Every other folder is unaffected, because only a root ends in
 * a backslash.
 */
function repairDriveRoot(value: string): string {
  return value.endsWith('"') ? value.slice(0, -1) + '\\' : value
}
