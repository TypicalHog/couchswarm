import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import nextConfig from '../next.config.mjs';

// oxlint-disable-next-line typescript/no-require-imports -- the loader under test is CommonJS.
const require = createRequire(import.meta.url);
const loader = require('../scripts/webtorrent-loader.cjs');
const bundle = fileURLToPath(import.meta.resolve('webtorrent/dist/webtorrent.min.js'));

// The loader can only refuse a patch it is handed, and only a build hands it one, so the occurrence counts are
// checked here too: an upgrade that reminifies the bundle or rewrites a patched string fails in the offline
// suite, with no build needed, and a rule that stopped routing the bundle to the loader at all fails with it.
test('every webtorrent patch reaches the installed bundle', () => {
  const rule = nextConfig.webpack({ module: { rules: [] } }).module.rules.find(({ use }) => use.endsWith('webtorrent-loader.cjs'));
  const code = readFileSync(bundle, 'utf8');
  assert.ok(rule?.test(bundle), 'the build does not route webtorrent.min.js to the loader');
  assert.notEqual(loader(code), code, 'webtorrent.min.js was patched with nothing');
});
