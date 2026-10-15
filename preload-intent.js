'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intentApi', {
  submit: (text) => ipcRenderer.send('intent:submit', String(text || '')),
  cancel: () => ipcRenderer.send('intent:cancel'),
});
