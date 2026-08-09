import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { app } from 'electron'

export interface LaunchSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Markers a running Claude Code session uses to tag its child processes. When
 * aterm is launched from inside such a session it inherits them, and would pass
 * them on to every tab. Claude Code would then consider itself a subprocess and
 * **write no transcript**, leaving the session unresumable. So they have to go.
 */
const INHERITED_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
]

/** The environment for tabs: inherited, but without a foreign session identity. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED_SESSION_MARKERS) delete env[name]
  return env
}

/**
 * Locates the Claude Code CLI. Order: ATERM_CLAUDE_PATH → PATH → the installer's
 * default location.
 */
export function resolveClaudeExe(): string | undefined {
  const override = process.env.ATERM_CLAUDE_PATH
  if (override && existsSync(override)) return override

  const candidates = ['claude.exe', 'claude.cmd', 'claude.bat']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of candidates) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }

  const fallback = join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe')
  return existsSync(fallback) ? fallback : undefined
}

/** Path to the bundled PowerShell startup profile (dev and packaged alike). */
export function profileScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'aterm-profile.ps1')
    : join(app.getAppPath(), 'resources', 'aterm-profile.ps1')
}

export function powershellLaunch(tabId: string, runtimeDir: string, useProfile: boolean): LaunchSpec {
  const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(),
    ATERM_TAB_ID: tabId,
    ATERM_RUNTIME_DIR: runtimeDir
  }

  const script = profileScriptPath()
  if (useProfile && existsSync(script)) {
    return {
      file,
      // -ExecutionPolicy Bypass so that neither a mark-of-the-web nor a stricter
      // policy can block the bundled profile.
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script],
      env
    }
  }
  return { file, args: ['-NoLogo'], env }
}

export function claudeLaunch(opts: {
  tabId: string
  sessionId: string
  resume: boolean
}): LaunchSpec {
  const exe = resolveClaudeExe()
  if (!exe) throw new Error('claude.exe not found (set PATH or ATERM_CLAUDE_PATH)')

  const claudeArgs = opts.resume
    ? ['--resume', opts.sessionId]
    : ['--session-id', opts.sessionId]

  const env: NodeJS.ProcessEnv = { ...baseEnv(), ATERM_TAB_ID: opts.tabId }

  // .cmd/.bat need an interpreter; the .exe is started directly.
  if (/\.(cmd|bat)$/i.test(exe)) {
    const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return { file: cmd, args: ['/c', exe, ...claudeArgs], env }
  }
  return { file: exe, args: claudeArgs, env }
}
