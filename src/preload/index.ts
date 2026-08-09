import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentActivityEvent,
  ClipboardPayload,
  PersistedState,
  PtyDataEvent,
  PtyExitEvent,
  RecentSession,
  SessionDetectedEvent,
  StartSpec,
  StartResult
} from '@shared/types'
import { IPC } from '../main/ipc'

const api = {
  pty: {
    start: (spec: StartSpec): Promise<StartResult> => ipcRenderer.invoke(IPC.ptyStart, spec),
    kill: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.ptyKill, tabId),
    write: (tabId: string, data: string): void => ipcRenderer.send(IPC.ptyWrite, tabId, data),
    resize: (tabId: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.ptyResize, tabId, cols, rows),
    onData: (cb: (e: PtyDataEvent) => void): void => {
      ipcRenderer.on(IPC.ptyData, (_e, payload: PtyDataEvent) => cb(payload))
    },
    onExit: (cb: (e: PtyExitEvent) => void): void => {
      ipcRenderer.on(IPC.ptyExit, (_e, payload: PtyExitEvent) => cb(payload))
    }
  },
  state: {
    load: (): Promise<PersistedState> => ipcRenderer.invoke(IPC.stateLoad),
    save: (state: PersistedState): Promise<void> => ipcRenderer.invoke(IPC.stateSave, state)
  },
  sessions: {
    recent: (): Promise<RecentSession[]> => ipcRenderer.invoke(IPC.sessionsRecent),
    resumable: (cwd: string, sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.sessionResumable, cwd, sessionId),
    newId: (): Promise<string> => ipcRenderer.invoke(IPC.newSessionId),
    onDetected: (cb: (e: SessionDetectedEvent) => void): void => {
      ipcRenderer.on(IPC.sessionDetected, (_e, payload: SessionDetectedEvent) => cb(payload))
    },
    onAgentActivity: (cb: (e: AgentActivityEvent) => void): void => {
      ipcRenderer.on(IPC.agentActivity, (_e, payload: AgentActivityEvent) => cb(payload))
    }
  },
  system: {
    homeDir: (): Promise<string> => ipcRenderer.invoke(IPC.homeDir),
    keymap: (): Promise<Record<string, string[]>> => ipcRenderer.invoke(IPC.keymapLoad),
    pickFolder: (startIn?: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.pickFolder, startIn),
    isGitRepo: (cwd: string): Promise<boolean> => ipcRenderer.invoke(IPC.isGitRepo, cwd),
    readClipboard: (): Promise<ClipboardPayload> => ipcRenderer.invoke(IPC.clipboardRead),
    writeClipboard: (text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.clipboardWrite, text)
  }
}

export type AtermApi = typeof api

contextBridge.exposeInMainWorld('aterm', api)
