import { writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PersistedState } from '@shared/types'
import { readJsonFile } from '../util/json'

const SCHEMA_VERSION = 1

const EMPTY: PersistedState = { version: SCHEMA_VERSION, tabs: [] }

/**
 * Persists the tab list. Written debounced on every change and unconditionally
 * on quit — a crash must not cost the user their tabs.
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
        // Newer or unknown format: set it aside rather than destroy data.
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

  /** Debounced (300 ms) — the renderer reports every little change. */
  save(state: PersistedState): void {
    this.latest = { ...state, version: SCHEMA_VERSION }
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => this.flush(), 300)
  }

  /** Synchronous and immediate — for before-quit. */
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
      // No reason to hold up shutdown.
    }
  }

  current(): PersistedState {
    return this.latest
  }
}
