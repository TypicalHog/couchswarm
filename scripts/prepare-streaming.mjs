import { copyFileSync } from 'node:fs';
for (const name of ['sw.min.js', 'sw.min.js.map'])
  copyFileSync(new URL(`../node_modules/webtorrent/dist/${name}`, import.meta.url), new URL(`../public/${name}`, import.meta.url));
