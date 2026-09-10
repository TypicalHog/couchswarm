# Put CouchSwarm on Vercel

The website runs on Vercel with a persistent Turso/libSQL database. The Windows helper runs on the room host’s computer and opens outbound HTTPS and WebRTC connections. Guests use the website. A TURN relay on a separate Linux server carries encrypted WebRTC traffic when a direct connection fails; video does not pass through Vercel functions or the database.

## 1. Publish the Windows download

The locally built file is `public/downloads/CouchSwarm-Helper-win-x64.zip`. Extract the whole ZIP and open `helper-package/CouchSwarm Helper.exe`. This portable build includes Node 24 and all native dependencies; users do not install Node. It is currently unsigned.

Build a fresh package on Windows x64 using Node 24 LTS:

```powershell
npm.cmd ci
npm.cmd run build:helper
```

The build also needs .NET Framework 4.x (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), Windows PowerShell 5.1 (`Compress-Archive`) — both inbox on Windows 10/11 — and internet access to `raw.githubusercontent.com`, from which it downloads the LICENSE of the exact Node version it bundles. Output is staged under `work/helper-package/`.

If your shell uses an older Node version, set `COUCHSWARM_NODE_BINARY` to a Node 24 `node.exe` before building. The build produces a SHA-256 checksum beside the ZIP, `THIRD-PARTY-NOTICES.txt` covering every bundled npm package, and `runtime\LICENSE` for the Node runtime. Upload the ZIP and checksum to your release/download host, then set `COUCHSWARM_HELPER_DOWNLOAD_URL` to the public HTTPS ZIP URL. Generated ZIPs are excluded from Git. The production interface hides the download until this URL is set.

Each build stamps its version into `CouchSwarm Helper.exe` (right-click, Properties, Details) and into the ZIP’s README.txt. To update, download the new ZIP and replace the extracted folder. The launcher is unsigned, so Windows SmartScreen shows a warning the first time it runs; choose More info, then Run anyway.

## 2. Create the database

Create a Turso database, obtain its libSQL URL and auth token, and put them in your local environment:

```powershell
$env:TURSO_DATABASE_URL = 'libsql://YOUR-DATABASE.turso.io'
$env:TURSO_AUTH_TOKEN = 'YOUR-DATABASE-TOKEN'
npm.cmd run db:migrate
```

The migration runner records checksums and applies each migration once. `drizzle/0000_init.sql` holds the whole schema, so a fresh database is one step behind an empty one. Use a separate database for previews.

## 3. Run the relay

Use a Linux VPS with Docker Compose and a public IPv4 directly assigned to its interface. Copy `deploy/turn/compose.yaml` and `.env.example` there; rename the latter `.env`, enter the real IP and hostname, and generate a random secret, for example `openssl rand -hex 32`. Keep `.env` private.

Allow inbound TCP/UDP 3478 and UDP 49160–49359 through the provider firewall, then run:

```sh
docker compose up -d
docker compose logs --tail=50
```

If the provider uses NAT, bind the server’s local IP in `--listening-ip` and `--relay-ip` and add `--external-ip=PUBLIC_IP/LOCAL_IP`. Do not leave documentation example addresses in the running configuration.

Set these on Vercel:

```text
COUCHSWARM_TURN_URLS=turn:YOUR_PUBLIC_IP:3478?transport=udp,turn:YOUR_PUBLIC_IP:3478?transport=tcp
COUCHSWARM_TURN_SECRET=THE_SAME_RANDOM_SECRET
```

Clients receive temporary credentials; the shared secret stays on the website server and relay. TURN REST credentials are minted with a lifetime of roughly 24 hours to match the room lifetime, so the relay host must stay NTP-synchronised: a clock more than a few minutes fast will reject freshly minted credentials, and one that is slow will honour expired ones. This configuration supports UDP and TCP TURN connections. Networks permitting only HTTPS may require TURN over TLS on port 443: install a certificate for the relay hostname, enable coturn TLS, and add a `turns:HOSTNAME:443?transport=tcp` URL. The relay needs its own IP if HTTPS already occupies that port. The included allocation quotas bound concurrency; monitor bandwidth and configure provider spending limits appropriate to your deployment. Browsers and helpers first contact a STUN server to learn their public address. Without `COUCHSWARM_STUN_URLS` this is Google’s `stun.l.google.com:19302`; set it to `stun:YOUR_PUBLIC_IP:3478` to keep connection setup on your own infrastructure.

## 4. Deploy the website

Import this repository in Vercel and leave **Root Directory** at the repository root. The included `vercel.json` selects Next.js and `npm run build`. This uses Webpack so the MKV worker transformation in `next.config.mjs` is applied. Vercel Analytics and Speed Insights are included and render only when `VERCEL` is set, so a local server ships neither script; enable both in the Vercel project to collect anything.

Set the environment variables from `.env.example`: the two database values, the TURN and STUN values, and the helper download URL. Then deploy. Every build runs the migration runner against `TURSO_DATABASE_URL`, so a commit that adds a file under `drizzle/` migrates that database on deploy. The helper pairs to the origin in the link, so no host-domain setting is compiled into its executable. A reverse proxy must reach CouchSwarm over loopback (localhost, 127.0.0.1 or ::1) for its X-Forwarded-Host/X-Forwarded-Proto headers to be used in the helper pairing link; on any other listening address those headers are ignored and the request URL is used. Set `COUCHSWARM_PUBLIC_ORIGIN` to the public origin with no trailing slash, for example `https://couch.example`, whenever the proxy reaches CouchSwarm on a non-loopback address (`proxy_pass http://10.0.0.5:3000`) or rewrites the upstream `Host` header (the usual Docker/Kubernetes shape, `proxy_pass http://app:3000` with `proxy_set_header Host $proxy_host`); when set it overrides both. It is a website setting and is not the standalone helper’s `COUCHSWARM_ORIGIN` described in README.md. Keep invite links on the stable production domain. Scope `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the Production environment and give the Preview environment its own Turso database; otherwise preview deployments read and write the production rooms.

CouchSwarm stores no rate-limit table. The room API guards itself with seat limits and a per-room join throttle only, so put a platform rate limit in front of `/api/` (a Vercel Firewall rule, or your proxy) on any publicly discoverable deployment.

## 5. Verify the deployed setup

Create a room, choose **Connect your helper**, download/extract/open the Windows app, create a pairing link, and paste it into the app. Load a torrent you can share and invite a second device on a different network. Each participant enables playback; the host starts after everyone buffers.

For a relay-only data test, set the TURN variables in your local terminal and run `npm run test:relay`. It tests every configured TURN URL separately, forces relay candidates, and checks both bytes and selected candidates. A live relay and network access are required; the test fails if either is missing.

## Local verification of the production build

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3002
```

`npm run build` migrates and builds against `TURSO_DATABASE_URL`, or against `.local/rooms.db` when it is unset; set it first to verify a real Turso database. In another terminal, set `TEST_ORIGIN=http://localhost:3002` and run `npm run test:rooms` and `npm run test:remote`. Browser UI QA and cross-network relay verification are separate from the native transfer and API tests.

Deployment references: [Vercel Next.js](https://vercel.com/docs/frameworks/nextjs), [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/quickstart), [coturn configuration](https://github.com/coturn/coturn/blob/master/README.turnserver).
