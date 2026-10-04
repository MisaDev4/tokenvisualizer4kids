'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Channel names are duplicated from chronicle-store.js's CHANNELS rather than
// required: this preload is sandboxed, so it may only pull from `electron`.
contextBridge.exposeInMainWorld('townAPI', {
  onData: cb => ipcRenderer.on('town:data', (_e, msg) => cb(msg)),
  ready: () => ipcRenderer.send('town:ready'),
  // The keepsake. `save` is fire-and-forget by design — every consumer must
  // already render correctly with the file absent, so nothing waits on a write.
  chronicle: {
    load: () => ipcRenderer.invoke('town:chronicle:load'),
    save: patch => ipcRenderer.send('town:chronicle:save', patch)
  },
  saveShot: (name, dataURL) => ipcRenderer.invoke('town:saveShot', name, dataURL)
});
