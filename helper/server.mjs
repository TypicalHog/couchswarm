import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTorrentHelper } from './torrent-helper.mjs';

const siteOrigin = process.env.COUCHSWARM_ORIGIN || 'http://localhost:3001';
const port = Number(process.env.COUCHSWARM_HELPER_PORT || 3791);
const helper = createTorrentHelper({ siteOrigin, cacheRoot: process.env.COUCHSWARM_HELPER_CACHE || fileURLToPath(new URL('../.torrent-cache', import.meta.url)) });
let bound = port;
const server = http.createServer((req, res) => {
  if (![`127.0.0.1:${bound}`, `localhost:${bound}`, new URL(siteOrigin).host].includes(req.headers.host)) {
    res.writeHead(403); res.end(); return;
  }
  helper.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.requestTimeout = 15000;
server.on('error', /** @param {NodeJS.ErrnoException} error */ error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Another CouchSwarm helper may be running; set COUCHSWARM_HELPER_PORT to use a different port.`
    : `The helper could not start: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => { bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port; console.log(`CouchSwarm helper: http://127.0.0.1:${bound}\nSite: ${new URL(siteOrigin).origin}\nKeep this process running while watching.`); });
async function stop() {
  server.close(); server.closeAllConnections();
  await helper.close();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
