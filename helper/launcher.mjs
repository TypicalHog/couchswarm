import { createInterface } from 'node:readline/promises';
import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteAgent } from './remote-agent.mjs';
import { defaultDownloads, helperLog } from './data-paths.mjs';

// The terminal counterpart of helper/Launcher.cs: the same three answers before anything starts — the pairing
// link, where the movies go, whether they stay — the same running status, and the same account of the downloaded
// data when it stops. It drives the agent in this process rather than through helper/desktop.mjs, because that
// bridge exists to cross the language boundary the C# window has and a Node front end does not.

const note = text => {
  // The terminal already showed this; the file is what is left of a session whose window is gone, and the
  // packaged README sends people to it. Capped the way the Windows launcher caps the log it keeps of the same.
  try {
    mkdirSync(path.dirname(helperLog), { recursive: true });
    if ((statSync(helperLog, { throwIfNoEntry: false })?.size || 0) > 262144) rmSync(helperLog, { force: true });
    appendFileSync(helperLog, `${new Date().toISOString()} ${text}\n`);
  } catch {}
};

const io = createInterface({ input: process.stdin, output: process.stdout });
// Piped into a script or started by a service manager there is nobody to answer, and a prompt nobody can see
// reads as a hang: take the defaults instead. The pairing link is the one answer with no default.
const ask = async (question, fallback) => process.stdin.isTTY ? (await io.question(question)).trim() || fallback : fallback;

console.log('CouchSwarm Helper\nYour computer brings the movie. Everyone brings a couch.\n');
let link = (process.argv[2] || '').trim();
if (!link && !process.stdin.isTTY) { console.error('Pass the pairing link from your room as the first argument, or run this in a terminal.'); process.exit(2); }
if (!link) link = (await io.question('Paste the pairing link from your room: ')).trim();
// A shell expands ~ before the program sees its arguments; a path typed at this prompt reaches us as it was typed.
const typed = await ask(`Download folder [${defaultDownloads}]: `, defaultDownloads);
const folder = path.resolve(typed.startsWith('~/') ? path.join(os.homedir(), typed.slice(2)) : typed);
const keepDownloads = /^y(es)?$/i.test(await ask('Keep the downloads when you quit? [Y/n] ', 'y'));
// Readline holds a terminal in raw mode, where Ctrl+C is a keystroke it delivers itself rather than the signal the
// shutdown below waits for. Nothing is asked after this, so give the terminal back.
io.close();
console.log(`\nDownloads: ${folder}${keepDownloads ? '' : ' (cleared when you quit)'}\nPress Ctrl+C to stop sharing.\n`);

let quitting = false, printed = '', paired = '';
const report = data => {
  const { status, site, peers, torrentPeers, problem, stopped } = /** @type {{ status: string, site?: string, peers?: number, torrentPeers?: number, problem?: boolean, stopped?: boolean }} */ (data);
  // Only some reports carry the site, and the room driving this helper has not changed in the ones between, so
  // keep the last one named rather than let the line lose and regain it every poll.
  if (site !== undefined) paired = site;
  const line = [status, paired && `paired with ${paired}`, peers !== undefined && `viewers ${peers}`, torrentPeers !== undefined && `torrent peers ${torrentPeers}`].filter(Boolean).join(' · ');
  // Every poll repeats the line the poll before it printed; only a change is worth a line of the terminal.
  if (line !== printed) {
    printed = line;
    console.log(`${new Date().toLocaleTimeString()}  ${line}`);
    // Something only the host can clear — an unwritable folder, a full drive, a torrent given up on — is exactly
    // what the log is for; the window colours its dot from the same flag.
    if (problem) note(status);
  }
  // The room can revoke this pairing, and then there is nothing left for the helper to do.
  if (stopped) void quit(0);
};
const agent = createRemoteAgent({ cacheRoot: folder, keepDownloads, report });

async function quit(code) {
  if (quitting) return;
  quitting = true;
  console.log('Stopping…');
  // Teardown can outlast a download folder that stopped answering, and the host has already asked to leave: say
  // what became of their data and go, rather than sit in a terminal that no longer responds to Ctrl+C.
  const deadline = new Promise(resolve => setTimeout(resolve, 15000).unref());
  await Promise.race([Promise.resolve(agent.stop()).catch(() => {}), deadline]);
  console.log(keepDownloads ? `Stopped. Downloaded movies stay in ${folder}.` : 'Stopped. Temporary movie data cleared.');
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  // A second Ctrl+C is a host who wants out now, mid-teardown or not.
  if (quitting) process.exit(130);
  console.log('');
  void quit(0);
});
// Whatever the torrent stack throws lands in the terminal by default and nowhere else; the log is the half that
// survives the terminal closing.
process.on('uncaughtException', error => { const text = error?.stack || String(error); console.error(text); note(text); process.exit(1); });

await agent.pair(link).catch(async error => {
  console.error(error.message);
  note(error.stack || error.message);
  await agent.stop().catch(() => {});
  process.exit(1);
});
