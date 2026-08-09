import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Is this directory inside a git working tree? Answered by walking up to the
 * root looking for `.git` rather than by running git — the answer is needed
 * while a menu is opening, and spawning a process for that is far too slow.
 *
 * `.git` is a directory in a normal clone but a *file* inside a worktree, so
 * both count: worktrees can be nested.
 */
export function isGitRepo(cwd: string): boolean {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
