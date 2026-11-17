import { shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Opening what a path in a terminal names. The text comes from whatever ran in a tab,
 * so a click must never run anything: a file Windows would execute rather than open is
 * shown in Explorer instead.
 */
const EXECUTABLE = new Set([
  ...(process.env['PATHEXT'] ?? '').toLowerCase().split(';').filter(Boolean),
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.lnk', '.url', '.vbs',
  '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.hta', '.cpl', '.reg', '.jar',
  '.appref-ms', '.application', '.msc', '.scf', '.inf'
])

/** The absolute path `candidate` names, tried against each base folder in turn. */
export function resolveExisting(candidate: string, bases: string[]): string | undefined {
  const path = candidate.replace(/^~(?=[\\/])/, homedir())
  if (isAbsolute(path)) return existsSync(path) ? resolve(path) : undefined
  for (const base of bases) {
    const full = join(base, path)
    if (existsSync(full)) return full
  }
  return undefined
}

/** Opens a file or folder, or a `file:` URL, with what Windows would open it with. */
export async function openInShell(target: string): Promise<boolean> {
  let path: string
  try {
    path = /^file:/i.test(target) ? fileURLToPath(target) : target
  } catch {
    return false
  }
  if (!isAbsolute(path) || !existsSync(path)) return false
  if (!statSync(path).isDirectory() && EXECUTABLE.has(extname(path).toLowerCase())) {
    shell.showItemInFolder(path)
    return true
  }
  return (await shell.openPath(path)) === ''
}
