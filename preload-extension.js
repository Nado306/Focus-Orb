'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('extApi', {
  get: () => ipcRenderer.invoke('ext:get'),
  setEnabled: (on) => ipcRenderer.invoke('ext:enable', !!on),
  openFolder: () => ipcRenderer.invoke('ext:install'),
  newToken: () => ipcRenderer.invoke('ext:newtoken'),
});
