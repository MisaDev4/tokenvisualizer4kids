// Copies the three.js module build into the renderer's vendor folder so the
// page has no reach into node_modules at runtime (and can be tested in a
// plain browser). Runs automatically on `npm install`.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.js');
const dstDir = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, path.join(dstDir, 'three.module.js'));
console.log('vendor: copied three.module.js');
