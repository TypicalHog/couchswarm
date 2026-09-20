import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { createRemoteAgent } from './remote-agent.mjs';

let agent, keepDownloads = false;
const report = data => process.stdout.write(`${JSON.stringify(data)}\n`);
// The launcher is the only reader, so its death breaks these pipes; stdin's 'close' below already runs the shutdown,
// and a status line written after that has nowhere to go. Unhandled, EPIPE would exit the process before cleanup.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
const input = createInterface({ input: process.stdin });
let pending = Promise.resolve();
input.on('line', line => {
  pending = pending.then(async () => {
    const command = JSON.parse(line);
    if (command.action === 'stop') { await agent?.stop().catch(() => {}); agent = undefined; report({ status: keepDownloads ? 'Stopped. Downloaded movies stay in your folder.' : 'Stopped. Temporary movie data cleared.', stopped: true }); }
    else if (command.action === 'pair') {
      await agent?.stop().catch(() => {});
      keepDownloads = command.keepDownloads === true;
      // The launcher sends its folder setting; empty means the default, which is only swept when downloads are not kept.
      const home = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CouchSwarm');
      agent = createRemoteAgent({ cacheRoot: command.folder || path.join(home, keepDownloads ? 'downloads' : 'cache'), keepDownloads, report });
      await agent.pair(command.url);
    }
  }).catch(error => report({ status: error.message, error: true }));
});
input.on('close', () => {
  // The launcher window only closes once this process exits.
  const deadline = new Promise(resolve => setTimeout(resolve, 15000).unref());
  void Promise.race([pending.then(() => agent?.stop()).catch(() => {}), deadline]).finally(() => process.exit(0));
});
process.on('SIGTERM', () => { void Promise.resolve(agent?.stop()).catch(() => {}).finally(() => process.exit(0)); });
report({ status: 'Paste the pairing link from your room to begin.' });
