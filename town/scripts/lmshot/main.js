// Landmark / village-tier proof sheet — a HIDDEN-window screenshot harness.
//
// The town's own `--shot` mode renders the real app, and the real app can only
// show the landmarks town.js's LADDER asks for. While the ladder is being
// rewired this harness is the only way to LOOK at the new landmark set, which
// the charter says is the only test that counts. It never shows a window: same
// contract as `electron . --shot=` (show:false, skipTaskbar, paintWhenInitiallyHidden,
// quits itself).
//
//   npx electron scripts/lmshot --shot=C:\abs\out.png [--row=a|b|tiers] [--hour=23]
//                               [--only=chapel] [--seed=7]
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');

const argOf = k => {
  const p = '--' + k + '=';
  const a = process.argv.find(s => s.startsWith(p));
  return a === undefined ? null : a.slice(p.length);
};

app.disableHardwareAcceleration === undefined || null;
app.commandLine.appendSwitch('force_high_performance_gpu');

app.whenReady().then(() => {
  const shot = argOf('shot') || path.join(process.cwd(), 'lmshot.png');
  const win = new BrowserWindow({
    width: 1600, height: 900,
    show: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
    backgroundColor: '#0D0D0D',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = (a[1] && typeof a[1] === 'object') ? a[1] : { level: a[1], message: a[2] };
    console.log('[page]', String(d.message ?? ''));
  });
  const query = {};
  for (const k of ['row', 'hour', 'only', 'seed', 'tier']) {
    const v = argOf(k); if (v !== null) query[k] = v;
  }
  win.loadFile(path.join(__dirname, 'index.html'), { query })
    .catch(e => console.error('[lmshot] load failed:', e.message));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        console.log('shot saved:', shot);
      } catch (e) { console.error('[lmshot] shot failed:', e.message); }
      app.quit();
    }, Number(argOf('shot-delay') || 3500));
  });
});
app.on('window-all-closed', () => app.quit());
