/** Alle IPC-Kanalnamen an einer Stelle — Main und Preload teilen sich diese Datei. */
export const IPC = {
  // Renderer → Main (invoke)
  ptyStart: 'pty:start',
  ptyKill: 'pty:kill',
  stateLoad: 'state:load',
  stateSave: 'state:save',
  sessionsRecent: 'sessions:recent',
  sessionResumable: 'sessions:resumable',
  pickFolder: 'dialog:pick-folder',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
  newSessionId: 'sessions:new-id',
  homeDir: 'app:home-dir',
  keymapLoad: 'keymap:load',

  // Renderer → Main (send, hochfrequent)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // Main → Renderer
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  sessionDetected: 'session:detected',
  agentActivity: 'agent:activity'
} as const
