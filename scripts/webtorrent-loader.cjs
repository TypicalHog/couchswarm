// WebTorrent ships its browser build minified with fsa-chunk-store bundled inside it, so what follows has no
// source file in this repo to correct and no upstream release to wait for. Rewrite it as webpack reads the
// bundle, and fail the build when a pattern moves, so an upgrade can never drop a patch in silence.
const patches = [
  // The OPFS writer polyfill — installed on engines that have no FileSystemFileHandle.createWritable — runs
  // every piece write through a worker whose message handler has no try/catch and answers only on the happy
  // path. A write that throws, a full storage allowance above all, leaves that write pending forever: the
  // store's callback never runs, so the torrent raises no error, the viewer is offered no Reconnect and the
  // room stays paused on 'Buffering'. Wrap the handler so a failure is posted back as the answer.
  {
    find: 'onmessage=async n=>{const i=n.ports[0],s=n.data;switch(s.type){',
    replace: 'onmessage=async n=>{const i=n.ports[0],s=n.data;try{switch(s.type){',
    count: 1,
  },
  {
    find: 'case"abort":case"close":t.close()}i.postMessage(0)}',
    replace: 'case"abort":case"close":t.close()}i.postMessage(0)}catch(d){try{t?.close()}catch{}i.postMessage(d instanceof Error?d:new Error(String(d)))}}',
    count: 1,
  },
  // A sync access handle short of room returns the count it managed to write rather than throwing, and the
  // count is dropped here, so the torrent would report a piece saved over a file holding part of it.
  {
    find: 'case"write":t.write(s.data,{at:s.position}),t.flush();break;',
    replace: 'case"write":if(t.write(s.data,{at:s.position})!==s.data.byteLength)throw new DOMException("No space available for this operation","QuotaExceededError");t.flush();break;',
    count: 1,
  },
  // The page reads the worker's reply with `instanceof Error`, which a structured-cloned DOMException need not
  // satisfy, so the error posted above would still settle the write as a success. The worker answers 0 and
  // nothing else when it succeeded: reject on anything that is not that.
  {
    find: 'i.port1.onmessage=e=>{e.data instanceof Error?n(e.data):t(e.data),',
    replace: 'i.port1.onmessage=e=>{0!==e.data?n(e.data):t(e.data),',
    count: 1,
  },
];
module.exports = function (code) {
  for (const { find, replace, count } of patches) {
    if (code.split(find).length - 1 !== count) throw new Error(`webtorrent.min.js: expected ${count} occurrences of the patched source`);
    code = code.replaceAll(find, replace);
  }
  return code;
};
