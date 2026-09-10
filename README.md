# CouchSwarm

[github.com/TypicalHog/couchswarm](https://github.com/TypicalHog/couchswarm) · created by TypicalHog, 2026 · released under [The Unlicense, MIT or Apache 2.0](LICENSE.md), your choice.

CouchSwarm plays torrents you choose. It hosts, indexes and provides no content, and its creator does not endorse using it to share or stream anything you have no right to.

A shared movie room built with React, WebTorrent, and playsvideo. Vercel runs Next.js with a Turso/libSQL database. The Windows helper retrieves video from ordinary torrent peers and delivers verified pieces to room participants over WebRTC, with TURN fallback. Each browser maintains its own buffer and follows the host’s authoritative timeline.

## Windows helper and Vercel

Download `public/downloads/CouchSwarm-Helper-win-x64.zip`, extract it, and open `helper-package/CouchSwarm Helper.exe`. The portable app includes Node; no separate runtime installation is needed. In your room, choose **Connect your helper**, create a pairing link, and paste it into the app. The host’s helper serves every guest who doesn’t run their own. A guest can pair their own helper the same way to download from torrent peers directly instead of through the host; guests without one only need the room invite link. The Windows helper ZIP is not committed: run `npm run build:helper` (or host a release) and set `COUCHSWARM_HELPER_DOWNLOAD_URL` before the “Download for Windows” link works.

Keep the helper open while watching. It supports one room with up to 12 viewers and places no limit on torrent size, so keep an eye on free disk space for a very large movie. Movie pieces are downloaded on demand and shared with viewers and torrent peers. **Keep downloads when I close** is on by default: the movie stays on disk in the download folder, which is `%LOCALAPPDATA%/CouchSwarm/downloads` unless **Browse** points somewhere else. A multi-file torrent gets its own subfolder there; a single-file torrent is written straight into the folder. Only the parts the room actually watched are downloaded, so a movie you stop early is kept incomplete. Clear that checkbox for the old behaviour, a temporary `room-*` folder removed when you stop sharing or close — inside your chosen folder, or `%LOCALAPPDATA%/CouchSwarm/cache` when you choose none. A forced process kill may leave one behind; remove it only while the helper is stopped. The folder and the checkbox are saved in `%LOCALAPPDATA%/CouchSwarm/settings.json`. Pairing links expire in five minutes and work once; restarting the helper requires a fresh link. The current Windows build is unsigned.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Vercel database, Windows download, and relay setup. `npm run build:helper` builds the portable ZIP on Windows x64 with Node 24 LTS. `npm run test:remote` checks pairing and real TCP → WebRTC transfers; `npm run test:relay` checks a configured live TURN server with relay-only connections.

## Run locally

Requires Node.js 22.13 or newer.

```powershell
npm.cmd install
npm.cmd run dev
```

That serves `http://localhost:3001` and needs no environment: the schema is applied before the dev server starts, into `.local/rooms.db` unless `TURSO_DATABASE_URL` names another database. `drizzle/0000_init.sql` is the whole schema, so a database that has fallen behind is fixed by deleting the `.local` folder and letting the next start recreate it; that discards every room it holds. Streaming uses a service worker, so use HTTPS or localhost; plain HTTP on a LAN address cannot stream torrents. CouchSwarm needs Chrome or Edge 116+, Firefox 124+, or Safari 17.4+; older browsers are refused with a message instead of failing mid-stream.

## Local development helper

The dev server serves the website only. A local room reaches a helper two ways: pair the Windows helper app above through **Connect your helper**, which works against `http://localhost:3001` like any other origin, or run the standalone `npm run helper` behind a proxy that serves its `/torrent-helper/` routes from the website’s own origin. Without either, the site probes `/torrent-helper/health`, gets nothing, and falls back to ordinary browser WebTorrent peers. The connection panel shows **Your helper** and the native torrent peer count when connected. Use **Reconnect to movie** after a helper error.

The browser opens a helper session using its existing room credential. The helper reads the room's source from the room API, obtains metadata through ordinary torrent discovery, and returns the original `.torrent` metadata plus an opaque web seed URL. Each browser still verifies piece hashes, maintains its own buffer, processes MKV locally, and follows the existing shared timeline. Multiple viewers in the same room reuse one helper download. Requested ranges prioritize the pieces required for playback and seeking; the helper does not download an entire movie in advance.

The helper supports two active room torrents and 24 viewer leases, with no cap on torrent size. It waits up to 90 seconds for metadata. Normal leaving releases the lease; an inactive lease expires after two minutes. Once its last lease ends the download is kept for about a minute so a reconnecting viewer reuses it; after that the native client stops and its generated `.torrent-cache/session-*` directory is deleted. A leftover `session-*` or `room-*` directory older than an hour is removed the next time the helper starts. A forced process kill can leave a cache directory behind; remove those directories only while the helper is stopped. Torrent data is excluded from Git and deployment packages. UPnP and NAT-PMP router changes are disabled.

The helper uses TCP and WebRTC for piece transfers, with UDP trackers and DHT for discovery. uTP transfers are disabled because the installed client waits through several uTP retries before falling back to TCP, delaying startup against TCP-only peers.

Run `npm run helper` for that standalone process. It listens only on `127.0.0.1:3791`; `COUCHSWARM_ORIGIN` selects the room website (default `http://localhost:3001`; it is not the website’s own `COUCHSWARM_PUBLIC_ORIGIN`, which sets the helper pairing-link origin) and `COUCHSWARM_HELPER_PORT` changes the listen port. `COUCHSWARM_HELPER_CACHE` moves its torrent cache directory (default `.torrent-cache` in this folder); it does not change the Windows helper app's download folder, which that app stores itself. Serve its `/torrent-helper/` routes through a reverse proxy at the **same HTTPS origin** as the website, preserving Host and Origin, to use it remotely. Room credentials and opaque per-viewer capabilities restrict access; foreign browser origins are rejected. This is a local companion, not a public multi-tenant torrent service. Do not expose the listener as an unauthenticated public gateway. Public deployment needs an operator access policy and bandwidth quotas.

Set `COUCHSWARM_HELPER_OFFLINE=1` before starting `npm run helper` to run the helper without DHT or trackers and to keep private-network peer hints and tracker URLs in a source. Use it only for local test fixtures; leave it unset for normal development.

For remote friends, use the paired Windows helper above and a publicly reachable website; a `localhost` invite works only on this computer. Pairing and connection setup use outbound HTTPS polling, so the host needs no tunnel or router port forwarding. Direct WebRTC is tried first; a configured TURN server supplies the relay fallback. Vercel functions do not run the native torrent process.

HTTPS `.torrent` URLs must return the file directly (no redirect), use public internet addresses, and be at most 4 MiB. Magnet metadata URL hints, third-party web seeds, private-network tracker URLs, and private-network peer hints are stripped from the native helper; the browser retains its normal web-seed support. A torrent is refused when a file that shares a piece with the video has a name WebTorrent cannot request as a web seed path (`#`, `?`, `%`, a control character, or a trailing space), a folder name Windows cannot create, or a name Windows would store as an existing file. Other filenames, including spaces and Unicode, are supported.

## Watching together

Paste a magnet or HTTPS `.torrent` URL, create the room, and share the invite link. Guests choose a name and enable playback on their device. The host can start after everyone buffers eight seconds (or the remaining video). A three-second scheduled start and periodic drift correction keep viewers close to the shared timeline. Host pause, seek, source changes, a new guest, buffer loss, or a disconnected host pause the room. Seeking requires everyone to buffer again. A buffer stall resumes on its own three seconds after everyone is ready again; every other pause waits for the host.

Rooms support 12 active participants and expire 24 hours after the last person leaves. Invite secrets and participant credentials are hashed in the room database (Turso on Vercel, a local libSQL file in development). Each tab keeps its own access credential and the room invite in session storage; a host also keeps a re-claim key in local storage until they leave. Invitees cannot control playback. Room APIs use revision checks and heartbeat sequence numbers to reject stale updates. Clients poll every second and pause if contact is lost for 3.5 seconds (a little longer on slow connections); small drift is corrected with playback speed and larger drift by seeking. Network timing means this is best-effort synchronization, not a frame-accurate guarantee.

## Torrent requirements

- Browsers connect to WebRTC-compatible peers and web seeds. The local helper acts as a web seed and connects to traditional (non-WebRTC) torrent peers over TCP, discovering them via UDP trackers and DHT; without a helper, a WebTorrent-capable seeder or reachable web seed must already be available.
- CouchSwarm adds public WebSocket trackers to discover WebRTC peers even when a magnet lists only UDP trackers. Extra trackers cannot supply missing seeders or connect a browser directly to ordinary torrent clients. Fully browser-only use requires an existing WebRTC swarm, an HTTPS web seed, or someone seeding their local files from a browser. Adding support for arbitrary traditional swarms requires a separate torrent bridge. These trackers are also announced when a paired helper delivers the movie.
- MKV, MP4, WebM, M4V, and OGV files are selectable. MKV uses playsvideo: native playback when compatible, otherwise on-demand remuxing into fragmented MP4 and conversion of supported audio formats (including AC3, EAC3, DTS, MP3, FLAC, and Opus) to AAC. Each participant runs this locally; the full movie is not copied into a conversion buffer. MKV needs Chrome, Edge, or Safari 17.1+; Firefox and iPhone Safari cannot construct MediaSource in a dedicated worker, so CouchSwarm now refuses MKV there with a clear message instead of failing with a ReferenceError.
- Video is passed through without re-encoding. Devices must support the video's codec (for example, HEVC support depends on browser and hardware). The helper bridges torrent transport; no server video transcoder is included.
- Indexed MKVs use their cue table to start and seek without scanning the entire movie. MKVs with missing or damaged cues can need a longer initial scan.
- `.torrent` URLs and web seeds must permit browser requests (CORS).
- The largest compatible video is selected first. When a torrent holds more than one video — a season pack, say — a **Video in this torrent** dropdown appears under the player listing each file by path; the host picks, and the whole room switches together.
- Keep the tab open. Downloaded pieces are uploaded to other peers; leaving destroys this client's torrent store, and anything a closed tab left behind is cleaned up the next time you open a movie. Only one CouchSwarm movie tab can run per browser profile; a second tab is refused with "This movie is already open in another CouchSwarm tab."

## Checks

```powershell
npm.cmd test
npm.cmd run test:rooms
npm.cmd run test:mkv
npm.cmd run test:helper
npm.cmd run test:remote
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
```

`npm run test:all` runs the three suites that need no server. `npm run test:rooms` and `npm run test:remote` use the running local server at `http://localhost:3001`; set `TEST_ORIGIN` if your printed URL differs. Set `COUCHSWARM_PACKAGED_TEST=1` to run `test:remote` against the built `work/helper-package` agent instead of `helper/`. The room integration test creates isolated rooms and checks invite access, host permissions, readiness, scheduled starts, buffer stalls, stale reports, seeking, source replacement, and leaving. The MKV check uses actual synthetic video/audio, reads an MKV over HTTP ranges, verifies a small cue-table read, remuxes its first and later segments, and checks both tracks and timestamps. Real WebRTC media playback still depends on an available swarm and the browser's codec support.

Helper tests seed synthetic files over loopback TCP, retrieve magnet metadata, and download the full single-file and multi-file payloads through a webseed-only consumer with piece-hash verification. They cover first-byte and mid-file seeking, `HEAD`, invalid ranges, separate viewer capabilities, shared downloads, cache deletion, origin/room authentication, idle expiry, size limits, and rejection of private-network torrent URLs. No public movie torrent or browser UI is used by these tests. WebTorrent exposes no bind address, so the synthetic seeders listen on every interface for the few seconds a check runs; nothing advertises the ephemeral port and Windows Firewall may prompt once.

## Sources

- [WebTorrent API](https://webtorrent.io/docs)
- [WebTorrent browser limitations](https://webtorrent.io/faq)
- [WebTorrent v3.0.21](https://github.com/webtorrent/webtorrent/releases/tag/v3.0.21)
- [playsvideo streaming MKV engine](https://github.com/kzahel/playsvideo)

The build copies the matching WebTorrent service worker into `public/sw.min.js`. Drizzle migrations define the room schema; `npm run db:migrate` applies them, and `predev` and `build` run it for you.

playsvideo is pinned to 0.4.7; a `mediabunny` devDependency pins its Mediabunny fork to the exact GitHub commit the lockfile resolves. Installing therefore requires GitHub to be reachable; there is no registry tarball or integrity hash for that entry. A scoped build transform makes its `embeddedSubtitlePolicy: 'off'` skip eager subtitle extraction, preventing unrelated whole-movie reads from competing with the torrent buffer, and narrows its per-fragment console logging to error and warning lines. `scripts/playsvideo-loader.cjs` reads the patch strings from `scripts/playsvideo-patches.json` and fails the build if an upgrade changes them, so review this transform when upgrading playsvideo. `npm audit` reports `ip@2.0.1` (GHSA-2p57-rm9w-gvfp) through bittorrent-tracker; only its UDP tracker-server parser imports it and only `ip.toString()` is called, and CouchSwarm never runs a tracker server, so the advisory is unreachable here. npm’s proposed fix is a semver-major webtorrent downgrade and is not applied. `npm ls` reports five extraneous `@emnapi`/`@napi-rs`/`@tybys` packages; these are the wasm32 optional fallbacks for skipped native bindings and are expected.
