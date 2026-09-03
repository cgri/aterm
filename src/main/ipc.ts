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
  isGitRepo: 'git:is-repo',
  keymapLoad: 'keymap:load',
  takePendingDirs: 'app:take-pending-dirs',

  // Renderer → main (send, high frequency)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  setAppearance: 'app:set-appearance',
  setAttention: 'app:set-attention',

  // Main → Renderer
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  sessionDetected: 'session:detected',
  agentActivity: 'agent:activity',
  openDirectory: 'app:open-directory'
} as const
