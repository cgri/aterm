import { readFileSync } from 'node:fs'

/**
 * Reads JSON, tolerating a leading BOM. Windows PowerShell writes one with
 * `Set-Content -Encoding utf8` — without this, JSON.parse fails silently while
 * the file still looks perfectly fine in any editor.
 */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    return parseJson<T>(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function parseJson<T>(text: string): T | undefined {
  const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}
