import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

// WebTorrent's video worker arms a 5 s timer on every pull while it has not learned that the browser cancels an
// abandoned stream, and fires it to reclaim a read whose page went away. Nothing cleared it when the page answered,
// so a stream died 5 s after its last pull whenever the player merely stopped reading on a full buffer; and once
// the cancel probe set the flag, pulls stopped clearing it at all, so a timer armed before the probe - by a worker
// the browser restarted under a playing movie - still fired. A reclaimed read ends in nothing, no data, no close
// and no error, and Chromium never asks again: the seat stalled for good with nothing to press. scripts/
// sw-patches.json runs the timer only while a pull waits for its answer, and reclaims an answered read the browser
// never cancels (Firefox never does) after 60 s without a pull instead, before its piece selection competes with
// the reads that replaced it. A pattern that moved stops the copy, so an upgrade cannot drop the patch in silence.
const patches = JSON.parse(readFileSync(new URL('./sw-patches.json', import.meta.url), 'utf8'));
let worker = readFileSync(new URL('../node_modules/webtorrent/dist/sw.min.js', import.meta.url), 'utf8');
for (const { find, replace, count } of patches) {
  if (worker.split(find).length - 1 !== count) throw new Error('webtorrent sw.min.js: a patched string moved; review scripts/sw-patches.json');
  worker = worker.replaceAll(find, replace);
}
writeFileSync(new URL('../public/sw.min.js', import.meta.url), worker);
copyFileSync(new URL('../node_modules/webtorrent/dist/sw.min.js.map', import.meta.url), new URL('../public/sw.min.js.map', import.meta.url));
