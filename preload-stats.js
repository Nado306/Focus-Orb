'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('statsApi', {
  get: () => ipcRenderer.invoke('stats:get'),
  day: (date) => ipcRenderer.invoke('stats:day', date),
  exportCsv: () => ipcRenderer.invoke('stats:export'),
});
