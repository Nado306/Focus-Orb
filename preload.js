'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orb', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onCommand: (cb) => ipcRenderer.on('cmd', (_e, c) => cb(c)),
  onDrift: (cb) => ipcRenderer.on('drift', (_e, d) => cb(d)),

  showMenu: () => ipcRenderer.send('menu:show'),
  state: (s) => ipcRenderer.send('state', s),
  tooltip: (t) => ipcRenderer.send('tooltip', t),
  sessionComplete: (info) => ipcRenderer.invoke('session:complete', info || {}),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),
});
