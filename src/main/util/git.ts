import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Runs git in `cwd`; undefined when it fails, git is missing or it takes too long. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, (err, stdout) =>
      done(err ? undefined : stdout)
    )
  })
}

/**
 * The root of the working tree `cwd` lies in, normalised for comparison — a worktree is
 * a working tree of its own. Undefined outside of git.
 */
export async function workingTreeRoot(cwd: string): Promise<string | undefined> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel'])
  return out?.trim() ? resolve(out.trim()).toLowerCase() : undefined
}

/** Does the working tree hold changes, untracked files included? Unknown counts as yes. */
export async function hasChanges(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain'])
  return out === undefined || out.trim() !== ''
}

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
