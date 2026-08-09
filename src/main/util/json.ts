import { readFileSync } from 'node:fs'

/**
 * Liest JSON und verträgt ein führendes BOM. Windows-PowerShell schreibt mit
 * `Set-Content -Encoding utf8` eines — ohne diese Behandlung scheitert
 * JSON.parse still, und die Datei sieht in jedem Editor trotzdem korrekt aus.
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
