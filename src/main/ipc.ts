/** Every IPC channel name in one place — main and preload share this file. */
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

  // Renderer → main (send, high frequency)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // Main → Renderer
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  sessionDetected: 'session:detected',
  agentActivity: 'agent:activity'
} as const
