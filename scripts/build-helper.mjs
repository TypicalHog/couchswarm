import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip, gunzipSync } from 'node:zlib';

const target = process.argv[2] || 'win-x64';
if (!['win-x64', 'linux-x64'].includes(target)) throw new Error(`Package win-x64 or linux-x64, not ${target}.`);
const linux = target === 'linux-x64';
// Windows x64 is host and target at once: the ZIP ships the node.exe this script is running and a GUI built by the
// compiler the OS itself carries. Nothing here can execute a Linux binary or compile for one, so that package is
// cross-built from wherever this runs, and every piece of it that belongs to the target is downloaded and checked.
if (!linux && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('Build the Windows x64 helper on Windows x64.');
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = path.join(root, 'work', linux ? 'helper-package-linux' : 'helper-package');
const app = path.join(stage, 'app');
const output = path.join(root, 'public', 'downloads', linux ? 'CouchSwarm-Helper-linux-x64.tar.gz' : 'CouchSwarm-Helper-win-x64.zip');
const inside = (base, file) => { const relative = path.relative(base, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
if (!inside(path.join(root, 'work'), stage) || !inside(path.join(root, 'public', 'downloads'), output)) throw new Error('Invalid output directory.');
// The assembly version must stay numeric, so package.json's version cannot carry a prerelease suffix. It is read
// here rather than beside the assembly it stamps, because the packaged manifest below carries it too.
const { version: appVersion } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const node = linux ? '' : process.env.COUCHSWARM_NODE_BINARY || process.execPath;
// The Linux runtime is pinned rather than asked: a binary this machine may not be able to execute cannot report its
// own version, and reading it from the download would only say what the download happened to be. v24.21.0 is LTS.
const version = linux ? process.env.COUCHSWARM_NODE_VERSION_LINUX || 'v24.21.0' : execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (!/^v(2[4-9]|[3-9]\d)\./.test(version)) throw new Error(linux ? `Package with Node 24 LTS or newer, not ${version}. COUCHSWARM_NODE_VERSION_LINUX names the runtime to fetch.` : 'Package with Node 24 LTS or newer. Set COUCHSWARM_NODE_BINARY to its node.exe.');
if (process.env.COUCHSWARM_NODE_BINARY_LINUX && !process.env.COUCHSWARM_NODE_VERSION_LINUX) throw new Error('Set COUCHSWARM_NODE_VERSION_LINUX beside COUCHSWARM_NODE_BINARY_LINUX: a Linux binary cannot be asked its version from here.');
const csc = linux ? '' : path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const tar = linux ? '' : path.join(process.env.WINDIR, 'System32', 'tar.exe');
// The wipe below throws away the last package that ran, so everything that can fail without touching a file happens
// first: an owner on Node 22, a missing compiler, an unreachable license or a runtime that will not download would
// otherwise leave an empty stage sitting beside the previous archive, which still looks like a finished build.
await Promise.all(linux ? [] : [csc, tar].map(file => fs.access(file)));
// Offline or behind a firewall this is where the build dies, and a bare 'fetch failed' names neither the host it
// wanted nor what to do about it; a link that accepts and then says nothing would otherwise wait out undici's
// five-minute default.
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) })
  .catch(error => { throw new Error(`Could not reach ${licenseUrl} for the Node runtime license (${error.cause?.code || error.cause?.message || error.name}). Packaging needs internet access.`); });
if (!license.ok) throw new Error(`Could not fetch the exact Node runtime license (${license.status} from ${licenseUrl}).`);
const licenseText = await license.text();
// The same voice as the license fetch, for the two downloads only the Linux package needs. The timeout covers the
// whole transfer, because one of them is 50 MB.
async function download(url, what) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
    .catch(error => { throw new Error(`Could not reach ${url} for ${what} (${error.cause?.code || error.cause?.message || error.name}). Packaging needs internet access.`); });
  if (!response.ok) throw new Error(`Could not download ${what} (${response.status} from ${url}).`);
  return Buffer.from(await response.arrayBuffer());
}
// Just enough tar to read those two downloads: a header block, its file data, and the padding to the next block.
// Any other kind of entry — a GNU long-name record, a symlink — is stepped over by the same arithmetic, which is
// safe here because both files this looks for sit well inside the 100-byte name field.
function readTar(buffer) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= buffer.length && buffer[offset] !== 0;) {
    const header = buffer.subarray(offset, offset + 512);
    // Every header field is NUL-padded to its width, and a name that fills it exactly carries no NUL at all.
    const field = (start, length) => { const text = header.toString('utf8', start, start + length); return text.includes('\0') ? text.slice(0, text.indexOf('\0')) : text; };
    const name = field(0, 100), prefix = field(345, 155), kind = field(156, 1);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    offset += 512;
    if (kind === '' || kind === '0') files.set(prefix ? `${prefix}/${name}` : name, buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
// A package whose native code is for the wrong platform fails only on the user's machine, which is what the smoke
// runs at the end exist to prevent and the one thing they cannot do for a package this machine cannot execute.
const elf = (buffer, what) => {
  if (buffer.length < 20 || buffer.toString('latin1', 0, 4) !== '\x7fELF' || buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 0x3e)
    throw new Error(`${what} is not a 64-bit little-endian x86-64 ELF binary; it starts ${buffer.toString('hex', 0, 4)}.`);
};
// nodejs.org publishes a .tar.xz at half the size that is no use here: Node can gunzip and cannot decompress xz.
// The extracted binary is cached under work/ against its version, so a rebuild is not another 50 MB and a version
// bump cannot be handed the runtime before it.
async function linuxRuntime() {
  const provided = process.env.COUCHSWARM_NODE_BINARY_LINUX;
  if (provided) return fs.readFile(provided);
  const cache = path.join(root, 'work', `node-${version}-linux-x64`);
  const cached = await fs.readFile(cache).catch(() => null);
  if (cached) return cached;
  const name = `node-${version}-linux-x64.tar.gz`;
  const archive = await download(`https://nodejs.org/dist/${version}/${name}`, `the Node ${version} Linux runtime`);
  const sums = (await download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, `the Node ${version} checksums`)).toString('utf8');
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== expected) throw new Error(`${name} does not match SHASUMS256.txt (${digest} against ${expected || 'no line for that file'}).`);
  const binary = [...readTar(gunzipSync(archive))].find(([file]) => file.endsWith('/bin/node'))?.[1];
  if (!binary) throw new Error(`No bin/node inside ${name}.`);
  // Rename rather than write in place: an interrupted write would otherwise be read back as a cached runtime.
  await fs.writeFile(`${cache}.partial`, binary);
  await fs.rename(`${cache}.partial`, cache);
  return binary;
}
const runtime = linux ? await linuxRuntime() : Buffer.alloc(0);
if (linux) elf(runtime, `The Node ${version} runtime`);
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, 'runtime'), { recursive: true });
await fs.mkdir(path.join(app, 'helper'), { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });
if (linux) {
  await fs.mkdir(path.join(stage, 'runtime', 'bin'), { recursive: true });
  await fs.writeFile(path.join(stage, 'runtime', 'bin', 'node'), runtime);
  // The tar writer below is what puts this bit in the archive, but on a Linux host the smoke runs execute this
  // very copy, so it needs the bit here too.
  await fs.chmod(path.join(stage, 'runtime', 'bin', 'node'), 0o755);
} else await fs.copyFile(node, path.join(stage, 'runtime', 'node.exe'));
await fs.writeFile(path.join(stage, 'runtime', 'LICENSE'), licenseText);
// The GUI is the Windows front end and launcher.mjs is the Linux one; neither has anything to do in the other package.
for (const file of ['constants.mjs', 'data-paths.mjs', 'desktop.mjs', 'remote-agent.mjs', 'remote-wire.mjs', 'torrent-helper.mjs', ...(linux ? ['launcher.mjs'] : [])])
  await fs.copyFile(path.join(root, 'helper', file), path.join(app, 'helper', file));
// The version is stamped into the manifest alone: the helper scripts are copied verbatim above, and the packaged
// suite proves a build is current by comparing them to the sources byte for byte.
await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'couchswarm-helper', private: true, type: 'module', version: appVersion }));
const visited = new Set();
const notices = [];
const unlicensed = [];
// prebuild-install runs in node-datachannel's npm install script, which a downloaded package never executes, and the
// bare-* packages are only chosen by the Bare runtime's export condition — under Node the same imports resolve to
// node:fs and its neighbours. The confined smoke runs at the end are what catch a wrong entry here.
const unused = new Set(['prebuild-install', 'bare-events', 'bare-fs', 'bare-path', 'bare-stream', 'bare-url']);
async function copyPackage(name, parent, optional = false) {
  if (unused.has(name)) return;
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
      // Dependencies check in editor and tool folders — .idea, .history — that the helper never reads; only the
      // parent parts are tested, so a package's own dotfiles still ship.
      if (parts.slice(0, -1).some(part => part.startsWith('.'))) return false;
      if (parts.some(part => ['test', 'tests', '__tests__', 'example', 'examples', 'docs', 'coverage', '.github'].includes(part))) return false;
      // Several of these packages carry a prebuild for every platform they support, and the target needs its own.
      // These directories are named for process.platform, which is win32 where the package is called win.
      const index = parts.indexOf('prebuilds');
      if (index >= 0 && parts.length > index + 1 && parts[index + 1] !== (linux ? 'linux-x64' : 'win32-x64')) return false;
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
  // This is the one package that keeps no prebuilds/ directory: prebuild-install fetches a single binding for the
  // machine it installs on, so what the walk just staged is this machine's — on Windows, a PE file. Take the
  // target's from the release the installer would have used. The binding is N-API, so it follows this version
  // rather than a Node ABI.
  if (linux) {
    const release = `node-datachannel-v${nativeVersion}-napi-v8-linux-x64.tar.gz`;
    const binding = [...readTar(gunzipSync(await download(`https://github.com/murat-dogan/node-datachannel/releases/download/v${nativeVersion}/${release}`, 'the linux-x64 node-datachannel binding')))]
      .find(([entry]) => entry.endsWith('node_datachannel.node'))?.[1];
    if (!binding) throw new Error(`No node_datachannel.node inside ${release}.`);
    elf(binding, 'The node-datachannel binding');
    await fs.writeFile(path.join(app, path.relative(root, native), 'build', 'Release', 'node_datachannel.node'), binding);
  }
}
await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n----\n\n'));
// The archive is the whole of what most people ever receive, so CouchSwarm's own terms have to travel with it.
await fs.copyFile(path.join(root, 'LICENSE.md'), path.join(stage, 'LICENSE.md'));
if (unlicensed.length) console.warn(`No license text for ${unlicensed.length} packages: ${unlicensed.join(', ')}`);
if (linux) {
  // The one file a host runs. It finds its own folder so the package works from any working directory, and leaves
  // that directory alone, so a relative download folder typed at the prompt means what the host meant by it.
  await fs.writeFile(path.join(stage, 'couchswarm-helper'), `#!/bin/sh
# CouchSwarm Helper. Everything it needs is in this folder; nothing is installed on this machine.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Company TLS inspection and antivirus HTTPS scanning put their root in the system store only, so without
# --use-system-ca every pairing fetch fails with a bare "fetch failed".
exec "$here/runtime/bin/node" --use-system-ca "$here/app/helper/launcher.mjs" "$@"
`);
  await fs.chmod(path.join(stage, 'couchswarm-helper'), 0o755);
} else {
  const info = path.join(root, 'work', 'AssemblyInfo.cs');
  await fs.writeFile(info, `using System.Reflection;\n[assembly: AssemblyTitle("CouchSwarm Helper")]\n[assembly: AssemblyProduct("CouchSwarm")]\n[assembly: AssemblyVersion("${appVersion}.0")]\n[assembly: AssemblyFileVersion("${appVersion}.0")]\n`);
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/platform:x64', `/out:${path.join(stage, 'CouchSwarm Helper.exe')}`,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', path.join(root, 'helper', 'Launcher.cs'), info,
  ], { stdio: 'inherit', windowsHide: true });
  // .NET Framework gates UI Automation live regions (the status label) behind these switches, and the status label's
  // LiveSetting itself only exists from 4.7.1, so the form's constructor throws on an older runtime before the window
  // appears. Naming the sku makes the CLR shim offer that install instead, which is a prerequisite a host can act on.
  await fs.writeFile(path.join(stage, 'CouchSwarm Helper.exe.config'), '<?xml version="1.0" encoding="utf-8"?>\r\n<configuration>\r\n  <startup>\r\n    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.7.1" />\r\n  </startup>\r\n  <runtime>\r\n    <AppContextSwitchOverrides value="Switch.UseLegacyAccessibilityFeatures=false;Switch.UseLegacyAccessibilityFeatures.2=false;Switch.UseLegacyAccessibilityFeatures.3=false" />\r\n  </runtime>\r\n</configuration>\r\n');
}
await fs.writeFile(path.join(stage, 'README.txt'), linux ? `CouchSwarm Helper for Linux x64
Needs glibc 2.28 or newer: Debian 10, Ubuntu 20.04, RHEL 8 and anything later.

1. Extract this entire archive: tar -xzf CouchSwarm-Helper-linux-x64.tar.gz
2. Run helper-package/couchswarm-helper in a terminal. No Node.js installation is needed.
3. In your room, choose Connect your helper, then Create pairing link.
4. Paste that private link into the helper when it asks, and answer its two questions.
5. Keep this terminal and the room tab open while watching. Guests only need the room link.

The helper needs a direct internet connection and cannot work through an HTTP or SOCKS proxy, even on a network where your room opens in the browser.

Downloads are kept in $XDG_DATA_HOME/CouchSwarm/downloads — ~/.local/share/CouchSwarm/downloads unless you set that variable — or in the folder you name at the prompt.
Only the parts the room watched are downloaded, so a movie you stop early is kept incomplete.
Answer n to "Keep the downloads when you quit?" to delete the movie when you stop sharing.
The helper uses as much disk space as the movie needs and uploads movie pieces to room viewers and torrent peers.
Press Ctrl+C to stop sharing; the helper says what became of the downloaded data before it exits.

If the helper will not start, or stops with an error, the details are in this terminal and in $XDG_STATE_HOME/CouchSwarm/helper.log — ~/.local/state/CouchSwarm/helper.log unless you set that variable.
Build ${appVersion} (Node ${version}).
CouchSwarm itself is released under The Unlicense, or MIT, or Apache 2.0, whichever you prefer; see LICENSE.md.
Third-party license notices are in THIRD-PARTY-NOTICES.txt and runtime/LICENSE.
` : `CouchSwarm Helper for Windows 10/11 x64\r\nNeeds .NET Framework 4.7.1 or later, which Windows 10 1803 and newer include.\r\n\r\n1. Extract this entire ZIP.\r\n2. Open CouchSwarm Helper.exe. No Node.js installation is needed.\r\n3. In your room, choose Connect your helper, then Create pairing link.\r\n4. Paste that private link into the helper and connect.\r\n5. Keep the helper and room tab open while watching. Guests only need the room link.\r\n\r\nWhen your first movie loads, Windows may ask whether "Node.js JavaScript Runtime" (this app's bundled runtime) can use your network.\r\nAllow it on private networks so torrent peers can reach you too.\r\nThe helper needs a direct internet connection and cannot work through an HTTP or SOCKS proxy, even on a network where your room opens in the browser.\r\n\r\nDownloads are kept in %LOCALAPPDATA%\\CouchSwarm\\downloads, or in the folder you choose.\r\nOnly the parts the room watched are downloaded, so a movie you stop early is kept incomplete.\r\nClear "Keep downloads when I close" to delete the movie when you stop sharing or close the app.\r\nThe helper uses as much disk space as the movie needs and uploads movie pieces to room viewers and torrent peers.\r\n\r\nIf the helper will not start, or stops with an error, the details are in %LOCALAPPDATA%\\CouchSwarm\\helper.log.\r\nBuild ${appVersion} (Node ${version}). This build is unsigned.\r\nCouchSwarm itself is released under The Unlicense, or MIT, or Apache 2.0, whichever you prefer; see LICENSE.md.\r\nThird-party license notices are in THIRD-PARTY-NOTICES.txt and runtime\\LICENSE.\r\n`);
// Node walks up out of the stage into this repo's own node_modules, so a package left off the list above still
// loads in the smoke runs below and only fails on a user's extracted copy. Confine both runs to what was staged.
// The hook file lives in work/ beside AssemblyInfo.cs, so it never reaches the package.
const confine = path.join(root, 'work', 'confine.mjs');
const packaged = path.join(stage, 'runtime', ...(linux ? ['bin', 'node'] : ['node.exe']));
// Those runs are the proof that the dependency list is complete and that the bridge starts, and they need a machine
// that can execute what was staged. Cross-building leaves the package unproven, which is worth saying out loud.
const unproven = linux && (process.platform !== 'linux' || process.arch !== 'x64');
if (!unproven) {
  await fs.writeFile(confine, `import { registerHooks } from 'node:module';
const app = ${JSON.stringify(pathToFileURL(app + path.sep).href)};
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (!resolved.url.startsWith('node:') && !resolved.url.startsWith(app)) throw new Error('Unstaged module ' + specifier + ' resolved outside the package: ' + resolved.url);
  return resolved;
} });
`);
  execFileSync(packaged, ['--use-system-ca', '--import', pathToFileURL(confine).href, '--input-type=module', '-e', "import WebTorrent from 'webtorrent'; import Peer from '@thaunknown/simple-peer'; import './helper/remote-agent.mjs'; const client = new WebTorrent({dht:false,tracker:false,lsd:false,natUpnp:false,natPmp:false,utp:false}); client.destroy(); console.log('Packaged native runtime OK');"], { cwd: app, stdio: 'inherit', windowsHide: true });
  const desktop = execFileSync(packaged, ['--use-system-ca', '--import', pathToFileURL(confine).href, 'helper/desktop.mjs'], { cwd: app, input: '{"action":"stop"}\n', encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (!desktop.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(value => value.stopped)) throw new Error('Packaged desktop IPC did not stop cleanly.');
}
// Windows has no POSIX permission bit to record, so bsdtar would write couchswarm-helper and runtime/bin/node
// without their executable bit and the package would be dead on arrival, with nothing in this output to hint at it.
// Writing the headers here is what puts the mode in the archive; a fixed mtime, uid and gid keep two builds of one
// tree byte-identical, and feeding gzip as the walk reads keeps the 130 MB runtime out of memory.
async function writeTarball(from, top, file, executable) {
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(file));
  const put = async buffer => { if (!gzip.write(buffer)) await once(gzip, 'drain'); };
  const entry = async (name, mode, kind, data) => {
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      // ustar splits a long path at a '/' into a 155-byte prefix and a 100-byte name. Nothing staged here is deep
      // enough to defeat that, and a path that cannot be split has to stop the build rather than be truncated.
      const at = [...name].findIndex((character, index) => character === '/' && Buffer.byteLength(name.slice(index + 1)) <= 100 && Buffer.byteLength(name.slice(0, index)) <= 155);
      if (at < 0) throw new Error(`Path too long for a tar header: ${name}`);
      prefix = name.slice(0, at);
      name = name.slice(at + 1);
    }
    const header = Buffer.alloc(512);
    const octal = (value, size) => `${value.toString(8).padStart(size - 1, '0')}\0`;
    header.write(name, 0, 100);
    header.write(octal(mode, 8), 100, 8);
    header.write(octal(0, 8), 108, 8);
    header.write(octal(0, 8), 116, 8);
    header.write(octal(data.length, 12), 124, 12);
    header.write(octal(0, 12), 136, 12);
    header.write('        ', 148, 8);
    header.write(kind, 156, 1);
    header.write('ustar\x0000', 257, 8);
    header.write(prefix, 345, 155);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    await put(header);
    if (data.length) { await put(data); await put(Buffer.alloc((512 - data.length % 512) % 512)); }
  };
  const walk = async (directory, prefix) => {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((one, two) => one.name < two.name ? -1 : 1)) {
      const name = prefix + item.name;
      if (item.isDirectory()) { await entry(`${name}/`, 0o755, '5', Buffer.alloc(0)); await walk(path.join(directory, item.name), `${name}/`); }
      else if (item.isFile()) await entry(name, executable.has(name) ? 0o755 : 0o644, '0', await fs.readFile(path.join(directory, item.name)));
      else throw new Error(`Cannot package ${name}: it is neither a file nor a directory.`);
    }
  };
  await entry(`${top}/`, 0o755, '5', Buffer.alloc(0));
  await walk(from, `${top}/`);
  // Two empty blocks are what ends a tar.
  await put(Buffer.alloc(1024));
  gzip.end();
  await written;
}
// tar writes in place, and the checksum is written after it, so a run that dies in between leaves a truncated
// archive beside a checksum for the one before it. Build alongside and swap the pair together; for the ZIP the
// .zip suffix is also what tells tar -a which format to write.
const partial = linux ? `${output}.partial` : output.replace(/\.zip$/, '.partial.zip');
// Compress-Archive stores '\' separators, which Info-ZIP reads as filenames; inbox bsdtar writes the '/' the ZIP format requires.
if (linux) await writeTarball(stage, 'helper-package', partial, new Set(['helper-package/couchswarm-helper', 'helper-package/runtime/bin/node']));
else execFileSync(tar, ['-a', '-c', '-f', partial, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit', windowsHide: true });
await fs.rm(`${output}.sha256`, { force: true });
await fs.rm(output, { force: true });
await fs.rename(partial, output);
const digest = createHash('sha256').update(await fs.readFile(output)).digest('hex');
await fs.writeFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(`Created ${output} (${visited.size} packages, Node ${version})\nSHA256 ${digest}`);
if (unproven) console.warn(`\n  ***  CROSS-BUILT AND NEVER EXECUTED  ***\n  Packaged on ${process.platform}-${process.arch}, so the two runs that prove the dependency list is complete\n  and that the helper's bridge starts were both skipped. Build this target on Linux x64, or try the package\n  on a Linux machine, before publishing it.\n`);
