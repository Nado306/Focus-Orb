'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  all: () => ipcRenderer.invoke('settings:all'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  action: (what, value) => ipcRenderer.invoke('settings:action', what, value),
  onChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
});
