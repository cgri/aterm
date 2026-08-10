/**
 * `claude --worktree` puts its worktree in `<project>\.claude\worktrees\<name>`,
 * and anything that learns a directory from Claude Code itself — `history.jsonl`
 * and so the session list — reports that path rather than the project it belongs
 * to. Both are needed: the project is what a session is filed under, the worktree
 * name is what tells two sessions of one project apart.
 *
 * Deliberately a string rule and not a git question: this is used while rendering,
 * so it must not touch the disk. A worktree somewhere else, added by hand rather
 * than by Claude Code, is therefore its own project.
 */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]*$/

/** The project a directory belongs to — itself, unless it is a worktree. */
export function projectDir(cwd: string): string {
  return cwd.replace(WORKTREE, '')
}

/** The worktree a directory *is*, if it is one. */
export function worktreeName(cwd: string): string | undefined {
  return WORKTREE.exec(cwd)?.[1]
}

/** The last segment of a path, for naming things after their directory. */
export function folderName(cwd: string): string {
  const leaf = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return leaf || cwd
}
