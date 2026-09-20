import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const inside = (base, target) => { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Reads the licence text out of node_modules for `names` and everything they depend on, so a notice file can be
// generated from what is actually installed rather than kept by hand. Returns the notices in install order and the
// packages that ship no licence file, which are named from their manifest instead.
export async function collectNotices(names, root) {
  const visited = new Set();
  const notices = [];
  const unlicensed = [];
  async function walk(name, parent, optional) {
    let directory;
    for (const base of createRequire(path.join(parent, 'package.json')).resolve.paths('__couchswarm_package_probe__') || []) {
      const candidate = path.join(base, name);
      if (!inside(root, candidate)) continue;
      try { await fs.access(path.join(candidate, 'package.json')); directory = candidate; break; } catch {}
    }
    if (!directory) { if (optional) return; throw new Error(`Missing dependency ${name}`); }
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    let text = '';
    // Multi-licensed packages ship LICENSE.MIT beside LICENSE.APACHE2, so concatenate every match; the catch covers a directory named licenses/.
    for (const file of (await fs.readdir(directory)).filter(file => /^(LICEN[CS]E|COPYING)([-.].*)?$/i.test(file)).sort())
      try { text += `${await fs.readFile(path.join(directory, file), 'utf8')}\n`; } catch {}
    if (!text) unlicensed.push(`${manifest.name}@${manifest.version}`);
    // A few packages still declare their terms in npm's legacy `licenses` array, and several that ship no licence
    // file have no licence or copyright line in their README either, so name the terms and the holder from the
    // manifest instead of sending the reader somewhere that says nothing.
    const declared = manifest.license || [manifest.licenses].flat().map(entry => entry?.type || entry).filter(Boolean).join(' OR ') || 'license not declared';
    const holder = [manifest.author, ...(manifest.contributors || [])].map(who => typeof who === 'string' ? who : who?.name).filter(Boolean).join(', ');
    // MPL-2.0 and the LGPL ask the recipient to be told where the source is; every other package is easier to find
    // with it too, and the manifest is the only place that knows.
    const source = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url || manifest.homepage || '';
    notices.push(`${manifest.name}@${manifest.version} — ${declared}${source ? `\nSource: ${source.replace(/^git\+/, '').replace(/\.git$/, '')}` : ''}\n`
      + (text || `No licence file ships with this package. Declared licence: ${declared}; copyright holder(s) per package.json: ${holder || 'not declared'}.\n`));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }))
      await walk(dependency, directory, !!manifest.optionalDependencies?.[dependency] || !!manifest.peerDependenciesMeta?.[dependency]?.optional);
  }
  for (const name of names) await walk(name, root, false);
  return { notices, unlicensed };
}
