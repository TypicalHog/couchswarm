import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 helper on Windows x64.');
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = path.join(root, 'work', 'helper-package');
const app = path.join(stage, 'app');
const output = path.join(root, 'public', 'downloads', 'CouchSwarm-Helper-win-x64.zip');
const inside = (base, target) => { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
if (!inside(path.join(root, 'work'), stage) || !inside(path.join(root, 'public', 'downloads'), output)) throw new Error('Invalid output directory.');
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, 'runtime'), { recursive: true });
await fs.mkdir(path.join(app, 'helper'), { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });
const node = process.env.COUCHSWARM_NODE_BINARY || process.execPath;
const version = execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (!/^v(2[4-9]|[3-9]\d)\./.test(version)) throw new Error('Package with Node 24 LTS or newer. Set COUCHSWARM_NODE_BINARY to its node.exe.');
await fs.copyFile(node, path.join(stage, 'runtime', 'node.exe'));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`);
if (!license.ok) throw new Error('Could not fetch the exact Node runtime license.');
await fs.writeFile(path.join(stage, 'runtime', 'LICENSE'), await license.text());
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
  notices.push(`${manifest.name}@${manifest.version} — ${manifest.license || 'license not declared'}\n${text || 'No license file ships with this package; see its README.'}`);
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
await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n----\n\n'));
if (unlicensed.length) console.warn(`No license text for ${unlicensed.length} packages: ${unlicensed.join(', ')}`);
// The assembly version must stay numeric, so package.json's version cannot carry a prerelease suffix.
const { version: appVersion } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const info = path.join(root, 'work', 'AssemblyInfo.cs');
await fs.writeFile(info, `using System.Reflection;\n[assembly: AssemblyTitle("CouchSwarm Helper")]\n[assembly: AssemblyProduct("CouchSwarm")]\n[assembly: AssemblyVersion("${appVersion}.0")]\n[assembly: AssemblyFileVersion("${appVersion}.0")]\n`);
execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
  '/nologo', '/target:winexe', '/platform:x64', `/out:${path.join(stage, 'CouchSwarm Helper.exe')}`,
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', path.join(root, 'helper', 'Launcher.cs'), info,
], { stdio: 'inherit', windowsHide: true });
// .NET Framework gates UI Automation live regions (the status label) behind these switches.
await fs.writeFile(path.join(stage, 'CouchSwarm Helper.exe.config'), '<?xml version="1.0" encoding="utf-8"?>\r\n<configuration>\r\n  <runtime>\r\n    <AppContextSwitchOverrides value="Switch.UseLegacyAccessibilityFeatures=false;Switch.UseLegacyAccessibilityFeatures.2=false;Switch.UseLegacyAccessibilityFeatures.3=false" />\r\n  </runtime>\r\n</configuration>\r\n');
await fs.writeFile(path.join(stage, 'README.txt'), `CouchSwarm Helper for Windows 10/11 x64\r\n\r\n1. Extract this entire ZIP.\r\n2. Open CouchSwarm Helper.exe. No Node.js installation is needed.\r\n3. In your room, choose Connect your helper, then Create pairing link.\r\n4. Paste that private link into the helper and connect.\r\n5. Keep the helper and room tab open while watching. Guests only need the room link.\r\n\r\nDownloads are kept in %LOCALAPPDATA%\\CouchSwarm\\downloads, or in the folder you choose.\r\nOnly the parts the room watched are downloaded, so a movie you stop early is kept incomplete.\r\nClear "Keep downloads when I close" to delete the movie when you stop sharing or close the app.\r\nThe helper uses as much disk space as the movie needs and uploads movie pieces to room viewers and torrent peers.\r\nBuild ${appVersion} (Node ${version}). This build is unsigned.\r\nThird-party license notices are in THIRD-PARTY-NOTICES.txt and runtime\\LICENSE.\r\n`);
execFileSync(path.join(stage, 'runtime', 'node.exe'), ['--use-system-ca', '--input-type=module', '-e', "import WebTorrent from 'webtorrent'; import Peer from '@thaunknown/simple-peer'; import './helper/remote-agent.mjs'; const client = new WebTorrent({dht:false,tracker:false,lsd:false,natUpnp:false,natPmp:false,utp:false}); client.destroy(); console.log('Packaged native runtime OK');"], { cwd: app, stdio: 'inherit', windowsHide: true });
const desktop = execFileSync(path.join(stage, 'runtime', 'node.exe'), ['--use-system-ca', 'helper/desktop.mjs'], { cwd: app, input: '{"action":"stop"}\n', encoding: 'utf8', timeout: 20000, windowsHide: true });
if (!desktop.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(value => value.stopped)) throw new Error('Packaged desktop IPC did not stop cleanly.');
await fs.rm(output, { force: true });
// Compress-Archive stores '\' separators, which Info-ZIP reads as filenames; inbox bsdtar writes the '/' the ZIP format requires.
execFileSync(path.join(process.env.WINDIR, 'System32', 'tar.exe'), ['-a', '-c', '-f', output, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit', windowsHide: true });
const digest = createHash('sha256').update(await fs.readFile(output)).digest('hex');
await fs.writeFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(`Created ${output} (${visited.size} packages, Node ${version})\nSHA256 ${digest}`);
