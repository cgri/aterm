import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { app } from 'electron'

export interface LaunchSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Marker, mit denen eine laufende Claude-Code-Session ihre Kindprozesse
 * kennzeichnet. Wird aterm aus einer solchen Session heraus gestartet, erbt
 * es sie — und würde sie an jeden Tab weiterreichen. Claude Code hielte sich
 * dann für einen Unterprozess und **schriebe kein Transkript**; die Session
 * ließe sich später nicht fortsetzen. Deshalb müssen sie hier weg.
 */
const INHERITED_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
]

/** Die Umgebung für Tabs: geerbt, aber ohne fremde Session-Identität. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of INHERITED_SESSION_MARKERS) delete env[name]
  return env
}

/**
 * Sucht die Claude-Code-CLI. Reihenfolge: ATERM_CLAUDE_PATH → PATH → der
 * Standard-Installationsort des Installers.
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

/** Pfad zum mitgelieferten PowerShell-Startprofil (dev wie paketiert). */
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
      // -ExecutionPolicy Bypass, damit weder Mark-of-the-Web noch eine strengere
      // Policy das mitgelieferte Profil blockiert (Plan: Risiken).
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
  if (!exe) throw new Error('claude.exe nicht gefunden (PATH oder ATERM_CLAUDE_PATH setzen)')

  const claudeArgs = opts.resume
    ? ['--resume', opts.sessionId]
    : ['--session-id', opts.sessionId]

  const env: NodeJS.ProcessEnv = { ...baseEnv(), ATERM_TAB_ID: opts.tabId }

  // .cmd/.bat brauchen einen Interpreter; die .exe wird direkt gestartet.
  if (/\.(cmd|bat)$/i.test(exe)) {
    const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return { file: cmd, args: ['/c', exe, ...claudeArgs], env }
  }
  return { file: exe, args: claudeArgs, env }
}
