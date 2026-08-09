import { writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PersistedState } from '@shared/types'
import { readJsonFile } from '../util/json'

const SCHEMA_VERSION = 1

const EMPTY: PersistedState = { version: SCHEMA_VERSION, tabs: [] }

/**
 * Persistiert die Tab-Liste. Geschrieben wird debounced bei jeder Änderung und
 * hart beim Beenden — ein Absturz darf die Tabs nicht kosten.
 */
export class SessionStore {
  private readonly file: string
  private pending?: NodeJS.Timeout
  private latest: PersistedState = EMPTY

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'state.json')
  }

  load(): PersistedState {
    if (!existsSync(this.file)) return { ...EMPTY }
    try {
      const parsed = readJsonFile<PersistedState>(this.file)
      if (typeof parsed?.version !== 'number' || parsed.version > SCHEMA_VERSION) {
        // Neuere/unbekannte Fassung: beiseitelegen statt Daten zu zerstören.
        copyFileSync(this.file, `${this.file}.bak`)
        return { ...EMPTY }
      }
      const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => t && t.id && t.cwd) : []
      this.latest = { ...EMPTY, ...parsed, tabs }
      return this.latest
    } catch {
      return { ...EMPTY }
    }
  }

  /** Debounced (300 ms) — der Renderer meldet jede Kleinigkeit. */
  save(state: PersistedState): void {
    this.latest = { ...state, version: SCHEMA_VERSION }
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => this.flush(), 300)
  }

  /** Synchron und sofort — für before-quit. */
  flush(): void {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = undefined
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.latest, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // Kein Grund, das Beenden zu blockieren.
    }
  }

  current(): PersistedState {
    return this.latest
  }
}
