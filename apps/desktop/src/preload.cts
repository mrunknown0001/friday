// Compiled to CommonJS: sandboxed preload scripts cannot be ES modules.
import { contextBridge, ipcRenderer } from 'electron';

// The whole bridge: four user-driven actions, no filesystem or shell access. The web UI's
// counterpart is apps/web/src/lib/desktop.ts.
contextBridge.exposeInMainWorld('fridayDesktop', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('friday:pick-folder'),
  restartServer: (): Promise<void> => ipcRenderer.invoke('friday:restart-server'),
  showConfigFile: (): Promise<void> => ipcRenderer.invoke('friday:show-config-file'),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('friday:focus-window'),
});
