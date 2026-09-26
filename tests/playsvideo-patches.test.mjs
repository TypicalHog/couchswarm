import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import nextConfig from '../next.config.mjs';

// oxlint-disable-next-line typescript/no-require-imports -- the loader under test is CommonJS.
const require = createRequire(import.meta.url);
const patches = require('../scripts/playsvideo-patches.json');
const loader = require('../scripts/playsvideo-loader.cjs');
const dist = new URL('.', import.meta.resolve('playsvideo'));

// The loader can only refuse a patch it is handed, and only a build hands it one, so the occurrence counts are
// checked here too: an upgrade that moves a patched file or rewrites a patched string fails in the offline
// suite, with no build needed, and a key the build would not route to the loader at all fails with it.
test('every playsvideo patch reaches the installed dist', () => {
  const [rule] = nextConfig.webpack({ module: { rules: [] } }).module.rules;
  for (const key of Object.keys(patches)) {
    const resourcePath = fileURLToPath(new URL(key, dist));
    const code = readFileSync(resourcePath, 'utf8');
    assert.ok(rule.test(resourcePath), `the build does not route dist/${key} to the loader`);
    assert.notEqual(loader.call({ resourcePath }, code), code, `dist/${key} was patched with nothing`);
  }
});
