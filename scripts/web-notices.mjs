import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNotices } from './third-party-notices.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

// ffmpeg-core.wasm ships inside playsvideo's dist and carries no licence file of its own, so the walk below never
// meets it. Its notice is kept here against the version that was reviewed, and the check underneath stops this
// script on a bump so somebody has to look at what the new build contains and where it came from.
const REVIEWED_PLAYSVIDEO = '0.4.7';
const wasm = `ffmpeg-core.wasm, shipped inside playsvideo@${REVIEWED_PLAYSVIDEO} and loaded in the browser to transcode audio for MKV playback — LGPL-2.1
Source: https://github.com/nicolo-ribaudo/ffmpeg.wasm, which builds FFmpeg (https://ffmpeg.org/). playsvideo states no GPL codecs are compiled in.
Licence text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
`;

const header = `Third-party notices for CouchSwarm

CouchSwarm's own terms are in LICENSE.md and cover nothing below. What follows is the
licence text shipped by every package CouchSwarm depends on, and by everything those
packages depend on in turn. Some of them run in your browser and some only on the
server; all of them are listed, each under its own terms.

Regenerate with: node scripts/web-notices.mjs
`;

const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'playsvideo', 'package.json'), 'utf8')).version;
if (installed !== REVIEWED_PLAYSVIDEO)
  throw new Error(`playsvideo is now ${installed}: check which ffmpeg.wasm build it ships and update the notice in scripts/web-notices.mjs.`);
const { notices, unlicensed } = await collectNotices(Object.keys(manifest.dependencies), root);
const file = path.join(root, 'public', 'third-party-notices.txt');
await fs.writeFile(file, [header, wasm, ...notices].join('\n----\n\n'));
if (unlicensed.length) console.warn(`No licence file ships with ${unlicensed.length} packages, named from their manifest instead: ${unlicensed.join(', ')}`);
console.log(`Wrote public/third-party-notices.txt for ${notices.length + 1} works.`);
