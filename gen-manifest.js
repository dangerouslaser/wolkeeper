#!/usr/bin/env node
// Generate the webosbrew manifest json for a built ipk.
// usage: node gen-manifest.js <ipk-path> <ipk-download-url>
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const [ipk, url] = process.argv.slice(2);
if (!ipk || !url) { console.error('usage: gen-manifest.js <ipk> <url>'); process.exit(2); }
const appinfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'appinfo.json')));
const bytes = fs.readFileSync(ipk);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = {
  id: appinfo.id,
  version: appinfo.version,
  type: appinfo.type,
  title: appinfo.title,
  appDescription: appinfo.appDescription,
  iconUri: 'https://raw.githubusercontent.com/dangerouslaser/wolkeeper/main/src/largeIcon.png',
  sourceUrl: 'https://github.com/dangerouslaser/wolkeeper',
  rootRequired: true,
  ipkUrl: url,
  ipkSize: bytes.length,
  ipkHash: { sha256: hash },
};
const out = `${appinfo.id}.manifest.json`;
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log('Wrote', out);
