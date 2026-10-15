'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profilesApi', {
  get: () => ipcRenderer.invoke('profiles:get'),
  save: (profiles, activeId) => ipcRenderer.invoke('profiles:save', { profiles, activeId }),
  exportFile: (scope, id) => ipcRenderer.invoke('profiles:export', { scope, id }),
  importFile: () => ipcRenderer.invoke('profiles:import'),
  onLive: (cb) => ipcRenderer.on('profiles:live', (_e, live) => cb(live)),
  onChanged: (cb) => ipcRenderer.on('profiles:changed', () => cb()),
});
