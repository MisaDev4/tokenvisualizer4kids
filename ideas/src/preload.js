// The whole bridge between the board and the disk. Sandboxed, so it may only
// pull from `electron`.
//
//   window.ideasAPI = {
//     load() -> Promise<{ok, doc, notice, readOnly, path}>
//         doc    = { v, app, rev, writtenMs, ideas: Idea[] }
//         notice = { kind:'migrated'|'created'|'recovered'|'quarantined'|'readonly', message } | null
//     save(doc) -> Promise<{ok, doc, external, error?}>
//         Send the WHOLE document. The returned `doc` is canonical — ids get
//         minted, order gets repacked. `external:true` means the file had
//         changed underneath you (the replaced copy is in .ideas-backups).
//     onExternalChange(cb) -> unsubscribe    // cb(doc) when ideas.json changes on disk
//   }
//
// New card: push `{ id:'', title:'…', status:'inbox', origin:'user', tags:['town'] }`
// into doc.ideas and save — the store mints the id (T-n town, K-n tracker) and
// hands it back. Declining without a reason is not a decision: the store stamps
// '(no reason recorded)' rather than drop it, so ask for one.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ideasAPI', {
  load: () => ipcRenderer.invoke('ideas:load'),
  save: doc => ipcRenderer.invoke('ideas:save', doc),

  onExternalChange: cb => {
    const h = (_e, doc) => { try { cb(doc); } catch (err) { console.error('[ideas] onExternalChange threw', err); } };
    ipcRenderer.on('ideas:changed', h);
    return () => ipcRenderer.removeListener('ideas:changed', h);
  }
});
