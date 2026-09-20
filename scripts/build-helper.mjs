import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 helper on Windows x64.');
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = path.join(root, 'work', 'helper-package');
const app = path.join(stage, 'app');
const output = path.join(root, 'public', 'downloads', 'CouchSwarm-Helper-win-x64.zip');
const inside = (base, target) => { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
if (!inside(path.join(root, 'work'), stage) || !inside(path.join(root, 'public', 'downloads'), output)) throw new Error('Invalid output directory.');
const node = process.env.COUCHSWARM_NODE_BINARY || process.execPath;
const version = execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (!/^v(2[4-9]|[3-9]\d)\./.test(version)) throw new Error('Package with Node 24 LTS or newer. Set COUCHSWARM_NODE_BINARY to its node.exe.');
const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const tar = path.join(process.env.WINDIR, 'System32', 'tar.exe');
// The wipe below throws away the last package that ran, so everything that can fail without touching a file happens
// first: an owner on Node 22, a missing compiler or an unreachable license would otherwise leave an empty stage
// sitting beside the previous ZIP, which still looks like a finished build.
await Promise.all([csc, tar].map(file => fs.access(file)));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`);
if (!license.ok) throw new Error('Could not fetch the exact Node runtime license.');
const licenseText = await license.text();
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, 'runtime'), { recursive: true });
await fs.mkdir(path.join(app, 'helper'), { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.copyFile(node, path.join(stage, 'runtime', 'node.exe'));
await fs.writeFile(path.join(stage, 'runtime', 'LICENSE'), licenseText);
for (const file of ['constants.mjs', 'desktop.mjs', 'remote-agent.mjs', 'remote-wire.mjs', 'torrent-helper.mjs']) await fs.copyFile(path.join(root, 'helper', file), path.join(app, 'helper', file));
await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'couchswarm-helper', private: true, type: 'module' }));
const visited = new Set();
const notices = [];
const unlicensed = [];
async function copyPackage(name, parent, optional = false) {
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
  // A few packages still declare their terms in npm's legacy `licenses` array, and several that ship no license file
  // have no license or copyright line in their README either, so name the terms and the holder from the manifest
  // instead of sending the reader somewhere that says nothing.
  const declared = manifest.license || [manifest.licenses].flat().map(entry => entry?.type || entry).filter(Boolean).join(' OR ') || 'license not declared';
  const holder = [manifest.author, ...(manifest.contributors || [])].map(who => typeof who === 'string' ? who : who?.name).filter(Boolean).join(', ');
  notices.push(`${manifest.name}@${manifest.version} — ${declared}\n${text || `No license file ships with this package. Declared license: ${declared}; copyright holder(s) per package.json: ${holder || 'not declared'}.`}`);
  await fs.cp(directory, path.join(app, path.relative(root, directory)), {
    recursive: true, filter: file => {
      const parts = path.relative(directory, file).split(path.sep);
      if (parts.includes('node_modules')) return false;
      if (parts.some(part => ['test', 'tests', '__tests__', 'example', 'examples', 'docs', 'coverage', '.github'].includes(part))) return false;
      const index = parts.indexOf('prebuilds');
      if (index >= 0 && parts.length > index + 1 && parts[index + 1] !== 'win32-x64') return false;
      return !/\.(map|ts|c|h|cc|gyp)$/.test(parts[parts.length - 1]);
    },
  });
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }))
    await copyPackage(name, directory, !!manifest.optionalDependencies?.[name] || !!manifest.peerDependenciesMeta?.[name]?.optional);
}
for (const name of ['webtorrent', '@thaunknown/simple-peer', 'bittorrent-protocol', 'ut_metadata', 'parse-torrent', 'range-parser']) await copyPackage(name, root);
// OpenSSL, usrsctp, libsrtp, libjuice and plog are compiled into node-datachannel's prebuilt binding, so the walk
// above never meets them as packages. Their notices are kept by hand against the version that was reviewed, and the
// file name carries it, so a bump stops the build until someone checks what the new binding links.
const native = [...visited].find(directory => path.basename(directory) === 'node-datachannel');
if (native) {
  const { version: nativeVersion } = JSON.parse(await fs.readFile(path.join(native, 'package.json'), 'utf8'));
  const file = path.join(root, 'scripts', 'native-notices', `node-datachannel-${nativeVersion}.txt`);
  const text = await fs.readFile(file, 'utf8').catch(() => { throw new Error(`Review the libraries linked into node-datachannel@${nativeVersion} and write ${file}.`); });
  notices.push(`Compiled into node-datachannel@${nativeVersion}\n${text}`);
}
await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n----\n\n'));
// The ZIP is the whole of what most people ever receive, so CouchSwarm's own terms have to travel with it.
await fs.copyFile(path.join(root, 'LICENSE.md'), path.join(stage, 'LICENSE.md'));
if (unlicensed.length) console.warn(`No license text for ${unlicensed.length} packages: ${unlicensed.join(', ')}`);
// The assembly version must stay numeric, so package.json's version cannot carry a prerelease suffix.
const { version: appVersion } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const info = path.join(root, 'work', 'AssemblyInfo.cs');
await fs.writeFile(info, `using System.Reflection;\n[assembly: AssemblyTitle("CouchSwarm Helper")]\n[assembly: AssemblyProduct("CouchSwarm")]\n[assembly: AssemblyVersion("${appVersion}.0")]\n[assembly: AssemblyFileVersion("${appVersion}.0")]\n`);
execFileSync(csc, [
  '/nologo', '/target:winexe', '/platform:x64', `/out:${path.join(stage, 'CouchSwarm Helper.exe')}`,
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', path.join(root, 'helper', 'Launcher.cs'), info,
], { stdio: 'inherit', windowsHide: true });
// .NET Framework gates UI Automation live regions (the status label) behind these switches.
await fs.writeFile(path.join(stage, 'CouchSwarm Helper.exe.config'), '<?xml version="1.0" encoding="utf-8"?>\r\n<configuration>\r\n  <runtime>\r\n    <AppContextSwitchOverrides value="Switch.UseLegacyAccessibilityFeatures=false;Switch.UseLegacyAccessibilityFeatures.2=false;Switch.UseLegacyAccessibilityFeatures.3=false" />\r\n  </runtime>\r\n</configuration>\r\n');
await fs.writeFile(path.join(stage, 'README.txt'), `CouchSwarm Helper for Windows 10/11 x64\r\n\r\n1. Extract this entire ZIP.\r\n2. Open CouchSwarm Helper.exe. No Node.js installation is needed.\r\n3. In your room, choose Connect your helper, then Create pairing link.\r\n4. Paste that private link into the helper and connect.\r\n5. Keep the helper and room tab open while watching. Guests only need the room link.\r\n\r\nWhen your first movie loads, Windows may ask whether "Node.js JavaScript Runtime" (this app's bundled runtime) can use your network.\r\nAllow it on private networks so torrent peers can reach you too.\r\n\r\nDownloads are kept in %LOCALAPPDATA%\\CouchSwarm\\downloads, or in the folder you choose.\r\nOnly the parts the room watched are downloaded, so a movie you stop early is kept incomplete.\r\nClear "Keep downloads when I close" to delete the movie when you stop sharing or close the app.\r\nThe helper uses as much disk space as the movie needs and uploads movie pieces to room viewers and torrent peers.\r\nBuild ${appVersion} (Node ${version}). This build is unsigned.\r\nCouchSwarm itself is released under The Unlicense, or MIT, or Apache 2.0, whichever you prefer; see LICENSE.md.\r\nThird-party license notices are in THIRD-PARTY-NOTICES.txt and runtime\\LICENSE.\r\n`);
// Node walks up out of the stage into this repo's own node_modules, so a package left off the list above still
// loads in the smoke runs below and only fails on a user's extracted copy. Confine both runs to what was staged.
// The hook file lives in work/ beside AssemblyInfo.cs, so it never reaches the package.
const confine = path.join(root, 'work', 'confine.mjs');
await fs.writeFile(confine, `import { registerHooks } from 'node:module';
const app = ${JSON.stringify(pathToFileURL(app + path.sep).href)};
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (!resolved.url.startsWith('node:') && !resolved.url.startsWith(app)) throw new Error('Unstaged module ' + specifier + ' resolved outside the package: ' + resolved.url);
  return resolved;
} });
`);
execFileSync(path.join(stage, 'runtime', 'node.exe'), ['--use-system-ca', '--import', pathToFileURL(confine).href, '--input-type=module', '-e', "import WebTorrent from 'webtorrent'; import Peer from '@thaunknown/simple-peer'; import './helper/remote-agent.mjs'; const client = new WebTorrent({dht:false,tracker:false,lsd:false,natUpnp:false,natPmp:false,utp:false}); client.destroy(); console.log('Packaged native runtime OK');"], { cwd: app, stdio: 'inherit', windowsHide: true });
const desktop = execFileSync(path.join(stage, 'runtime', 'node.exe'), ['--use-system-ca', '--import', pathToFileURL(confine).href, 'helper/desktop.mjs'], { cwd: app, input: '{"action":"stop"}\n', encoding: 'utf8', timeout: 20000, windowsHide: true });
if (!desktop.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(value => value.stopped)) throw new Error('Packaged desktop IPC did not stop cleanly.');
// tar writes in place, and the checksum is written after it, so a run that dies in between leaves a truncated ZIP
// beside a checksum for the one before it. Build alongside and swap the pair together; the .zip suffix is what tells
// tar -a which format to write.
const partial = output.replace(/\.zip$/, '.partial.zip');
// Compress-Archive stores '\' separators, which Info-ZIP reads as filenames; inbox bsdtar writes the '/' the ZIP format requires.
execFileSync(tar, ['-a', '-c', '-f', partial, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit', windowsHide: true });
await fs.rm(`${output}.sha256`, { force: true });
await fs.rm(output, { force: true });
await fs.rename(partial, output);
const digest = createHash('sha256').update(await fs.readFile(output)).digest('hex');
await fs.writeFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(`Created ${output} (${visited.size} packages, Node ${version})\nSHA256 ${digest}`);
