import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connectRemoteHelper, type HelperStatus } from '../lib/remote-helper.ts';
import type { Session } from '../lib/sync.ts';

const session: Session = { roomId: 'room', memberId: 'member', token: 'a'.repeat(64), invite: 'invite' };
const helperStatus = (extra: Partial<HelperStatus> = {}): HelperStatus => ({ paired: true, online: true, ready: false,
  own: true, mine: true, mineOnline: true, mineStatus: '', status: 'Finding torrent peers…', infoHash: '',
  downloadUrl: '', iceServers: [], relayAvailable: false, ...extra });
const connect = (report: (message: string) => void = () => {}) =>
  connectRemoteHelper(session, 0, new AbortController().signal, report, () => {});
const realFetch = globalThis.fetch;
// Every reply is served from memory, so one setImmediate drains the whole request before the next tick.
const flush = () => new Promise<void>(resolve => { setImmediate(() => resolve()); });
async function advance(seconds: number) {
  for (let i = 0; i < seconds; i++) { await flush(); mock.timers.tick(1000); }
  await flush();
}
function stub(t: TestContext, reply: (call: number) => HelperStatus | Error, timers = true) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const value = reply(++calls);
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => value };
  }) as unknown as typeof fetch;
  mock.timers.reset();
  if (timers) mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => { globalThis.fetch = realFetch; mock.timers.reset(); });
  return () => calls;
}

test('an unpaired room returns null without a second request', async t => {
  const calls = stub(t, () => helperStatus({ paired: false }), false);
  assert.equal(await connect(), null);
  assert.equal(calls(), 1, 'the wait loop is never entered');
});

test('a pairing revoked mid-wait returns null', async t => {
  const calls = stub(t, call => helperStatus({ paired: call === 1 }));
  const connecting = connect();
  await advance(2);
  assert.equal(await connecting, null);
  assert.equal(calls(), 2);
});

test('a helper offline past the 20 s deadline falls back to browser peers', async t => {
  const reports: string[] = [];
  stub(t, () => helperStatus({ online: false }));
  const connecting = connect(message => reports.push(message));
  await advance(22);
  assert.equal(await connecting, null);
  assert.equal(reports[0], 'Open your helper to continue…', 'an offline helper of the caller names the caller');
});

test('an online helper that never becomes ready fails at the 120 s deadline', async t => {
  const reports: string[] = [];
  stub(t, () => helperStatus());
  const connecting = connect(message => reports.push(message));
  // The rejection lands while advance() is still ticking, so claim it before the deadline passes.
  void connecting.catch(() => {});
  await advance(121);
  await assert.rejects(connecting, /Your helper is not ready/);
  assert.equal(reports[0], 'Finding torrent peers…', 'an online helper reports its own status');
});

test('three failed readiness polls are tolerated and a fourth gives up', async t => {
  // Polls 2-4 and 6-8 fail: only a counter cleared by the success at poll 5 survives to answer at poll 9.
  stub(t, call => call === 1 || call === 5 ? helperStatus() : call === 9 ? helperStatus({ paired: false }) : new Error('offline'));
  const tolerated = connect();
  await advance(10);
  assert.equal(await tolerated, null);
  stub(t, call => call === 1 ? helperStatus() : new Error('offline'));
  const abandoned = connect();
  void abandoned.catch(() => {});
  await advance(6);
  await assert.rejects(abandoned, /offline/);
});
