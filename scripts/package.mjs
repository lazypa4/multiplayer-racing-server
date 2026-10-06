// Builds the two upload packages next to this project:
//   turbo-rivals-netlify.zip  the website for Netlify (index.html at the top level)
//   turbo-rivals-server.zip   the game server for Render or any Node.js host
//
// Usage: npm run package -- https://your-server.onrender.com
// The URL is written into the Netlify site's config.js. Without it, config.js
// gets a placeholder you can edit before uploading.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let serverUrl = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (serverUrl && !/^https?:\/\//.test(serverUrl)) serverUrl = `https://${serverUrl}`;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-rivals-'));
const copy = (from, to) => fs.cpSync(path.join(ROOT, from), to, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
const zip = (dir, out) => {
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-rq', out, '.'], { cwd: dir });
};

// Website: public/ plus shared/, with index.html at the root of the zip.
const site = path.join(stage, 'site');
copy('public', site);
copy('shared', path.join(site, 'shared'));
const configPath = path.join(site, 'config.js');
const config = fs.readFileSync(configPath, 'utf8').replace(
  /^window\.TURBO_RIVALS_SERVER = .*$/m,
  `window.TURBO_RIVALS_SERVER = '${serverUrl || 'https://YOUR-SERVER.onrender.com'}';`,
);
fs.writeFileSync(configPath, config);
zip(site, path.join(ROOT, 'turbo-rivals-netlify.zip'));

// Server: everything `npm start` needs, ready to upload to GitHub for Render.
const server = path.join(stage, 'server');
for (const f of ['server.js', 'bot.js', 'package.json', 'package-lock.json', 'render.yaml', 'Procfile', 'README.md', '.gitignore', 'public', 'shared', 'scripts']) {
  copy(f, path.join(server, f));
}
zip(server, path.join(ROOT, 'turbo-rivals-server.zip'));

fs.rmSync(stage, { recursive: true, force: true });
console.log('Created turbo-rivals-netlify.zip and turbo-rivals-server.zip');
console.log(serverUrl ? `Website will connect to ${serverUrl}` : 'No server URL given: edit config.js in the Netlify package before uploading.');
