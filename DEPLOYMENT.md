# Put CouchSwarm on Vercel

The website runs on Vercel with a persistent Turso/libSQL database. The Windows helper runs on the room host’s computer and opens outbound HTTPS and WebRTC connections. Guests use the website. A TURN relay on a separate Linux server carries encrypted WebRTC traffic when a direct connection fails; video does not pass through Vercel functions or the database.

## 1. Publish the Windows download

The locally built file is `public/downloads/CouchSwarm-Helper-win-x64.zip`. Extract the whole ZIP and open `helper-package/CouchSwarm Helper.exe`. This portable build includes Node 24 and all native dependencies; users do not install Node. It is currently unsigned.

Build a fresh package on Windows x64 using Node 24 LTS:

```powershell
npm.cmd ci
npm.cmd run build:helper
```

The build also needs .NET Framework 4.x (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), `tar.exe` (`%WINDIR%\System32\tar.exe`) — both inbox on Windows 10 1803 and newer — and internet access to `raw.githubusercontent.com`, from which it downloads the LICENSE of the exact Node version it bundles. Output is staged under `work/helper-package/`.

If your shell uses an older Node version, set `COUCHSWARM_NODE_BINARY` to a Node 24 `node.exe` before building. The build produces a SHA-256 checksum beside the ZIP, `THIRD-PARTY-NOTICES.txt` covering every bundled npm package, and `runtime\LICENSE` for the Node runtime. Upload the ZIP and checksum to your release/download host, then set `COUCHSWARM_HELPER_DOWNLOAD_URL` to the public HTTPS ZIP URL. Generated ZIPs are excluded from Git. The production interface hides the download until this URL is set.

Each build stamps its version into `CouchSwarm Helper.exe` (right-click, Properties, Details) and into the ZIP’s README.txt. To update, download the new ZIP and replace the extracted folder. The launcher is unsigned, so Windows SmartScreen shows a warning the first time it runs; choose More info, then Run anyway.

## 2. Create the database

Create a Turso database in the region your Vercel functions run in, and set that region in the Vercel project; each room request makes five or six sequential libSQL round trips and every member sends one per second, so a database on another continent adds roughly half a second to every heartbeat. When the primary must live elsewhere, put a Turso replica in the function region. Obtain its libSQL URL and auth token, and put them in your local environment:

```powershell
$env:TURSO_DATABASE_URL = 'libsql://YOUR-DATABASE.turso.io'
$env:TURSO_AUTH_TOKEN = 'YOUR-DATABASE-TOKEN'
npm.cmd run db:migrate
```

The migration runner records checksums and applies each migration once. `drizzle/0000_init.sql` holds the whole schema, so a new database reaches the current schema in a single migration. Use a separate database for previews. Migration files are immutable once applied: the runner compares a SHA-256 of each file against the checksum it recorded and aborts the build when they differ, so add a new `drizzle/NNNN_*.sql` rather than editing or renaming a deployed one. If a build fails with `Applied migration changed`, revert the edit; to adopt an edit you have verified changes no DDL, run `UPDATE couchswarm_migrations SET checksum = 'NEW_SHA256' WHERE name = 'FILE.sql';` against the database first.

## 3. Run the relay

Use a Linux VPS with Docker Compose and a public IPv4 directly assigned to its interface. Copy `deploy/turn/compose.yaml` and `.env.example` there; rename the latter `.env`, enter the real IP and hostname, and generate a random secret, for example `openssl rand -hex 32`. Keep `.env` private.

Allow inbound TCP/UDP 3478 and UDP 49160–49359 through the provider firewall, then run:

```sh
docker compose up -d
docker compose logs --tail=50
```

The relay’s own public address has to stay an allowed peer so that two relayed clients can reach each other, and coturn’s peer list matches addresses, not ports; relayed UDP therefore reaches every other UDP port on this host over loopback, past the provider firewall, coturn’s own 3478 included. Either run no other UDP service on the relay host, or drop that traffic on the host itself:

```sh
sudo sysctl -w net.ipv4.ip_local_reserved_ports=49160-49359
sudo iptables -t raw -I OUTPUT -p udp -m addrtype --dst-type LOCAL --sport 49160:49359 ! --dport 49160:49359 -j DROP
```

The sysctl stops the kernel handing a relay port to an unrelated outbound socket, and the rule sits in the `raw` table so Docker’s NAT cannot route around it. Neither survives a reboot; persist both the way your distribution does.

If the provider uses NAT, bind the server’s local IP in `--listening-ip` and `--relay-ip` and add `--external-ip=PUBLIC_IP/LOCAL_IP`. Do not leave documentation example addresses in the running configuration.

Set these on Vercel:

```text
COUCHSWARM_TURN_URLS=turn:YOUR_PUBLIC_IP:3478?transport=udp,turn:YOUR_PUBLIC_IP:3478?transport=tcp
COUCHSWARM_TURN_SECRET=THE_SAME_RANDOM_SECRET
```

Clients receive temporary credentials; the shared secret stays on the website server and relay. TURN REST credentials are minted with a lifetime of roughly 24 hours to match the room lifetime, so the relay host must stay NTP-synchronised: a clock roughly a day fast will reject freshly minted credentials, and one that is slow will honour expired ones. This configuration accepts UDP and TCP TURN connections from browsers; the Windows helper’s ICE stack relays over UDP only, so the host’s network must allow outbound UDP to 3478 and the relay port range. Networks permitting only HTTPS may require TURN over TLS on port 443: install a certificate for the relay hostname, enable coturn TLS, and add a `turns:HOSTNAME:443?transport=tcp` URL. That URL serves browser guests; a host behind a UDP-blocking network cannot relay through it. The relay needs its own IP if HTTPS already occupies that port. The relay's per-user quota counts allocations per TURN credential identity: every browser member gets its own, but a helper serves all of a room's viewers under one, so it is sized for a full room plus reconnect churn; `--total-quota` is the server-wide bound, and `--max-allocate-lifetime` returns an abandoned allocation’s slot after ten minutes instead of coturn’s hour. `--max-bps` caps one relayed session at 3 MB/s and `--bps-capacity` caps the server at 50 MB/s combined, so roughly sixteen sessions relay at once before coturn answers further allocations with 486; raise both to the bandwidth your VPS plan can afford, and keep provider spending limits as the outer bound. Credentials are issued to any member of a room and room creation is unauthenticated, so three self-created identities can hold the whole 128-allocation quota; the per-IP limit in section 4 raises the cost of minting them but does not prevent it. Browsers and helpers first contact a STUN server to learn their public address. Without `COUCHSWARM_STUN_URLS` this is Google’s `stun.l.google.com:19302`; set it to `stun:YOUR_PUBLIC_IP:3478` to keep connection setup on your own infrastructure.

## 4. Deploy the website

Import this repository in Vercel and leave **Root Directory** at the repository root. The included `vercel.json` selects Next.js and `npm run build`. This uses Webpack so the MKV worker transformation in `next.config.mjs` is applied. Vercel Analytics and Speed Insights are included and render only when `VERCEL` is set, so a local server ships neither script; enable both in the Vercel project to collect anything. The build also fetches the Geist and Geist Mono webfaces through `next/font/google`, so it needs internet access to `fonts.googleapis.com` and `fonts.gstatic.com`; the woff2 files it downloads are self-hosted under `.next/static/media`, so the deployed site never contacts Google. Without that access `next dev` falls back to local Arial with a console error, while `npm run build` fails outright.

Set the environment variables from `.env.example`: the two database values, the TURN and STUN values, and the helper download URL. Then deploy. Every build runs the migration runner against `TURSO_DATABASE_URL`, so a commit that adds a file under `drizzle/` migrates that database on deploy. It runs before `next build`, so the migration is already committed if the build then fails, and `vercel rollback` restores code but not schema: keep every migration readable by the deployment still serving — add columns and tables in one commit and drop them in a later one, once no deployed code names them. The helper pairs to the origin in the link, so no host-domain setting is compiled into its executable. The pairing link's origin is `COUCHSWARM_PUBLIC_ORIGIN` when set, otherwise the request's `Host` header with the forwarded scheme; `X-Forwarded-Host` is never trusted. Set `COUCHSWARM_PUBLIC_ORIGIN` to the public origin with no trailing slash, for example `https://couch.example`, whenever the proxy rewrites the upstream `Host` header (the usual Docker/Kubernetes shape, `proxy_pass http://app:3000` with `proxy_set_header Host $proxy_host`); it overrides the derived origin and is worth setting on any proxied deployment. It is a website setting and is not the standalone helper’s `COUCHSWARM_ORIGIN` described in README.md. Keep invite links on the stable production domain. Scope `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the Production environment and give the Preview environment its own Turso database; otherwise preview deployments read and write the production rooms.

CouchSwarm stores no rate-limit table. The room API guards itself with seat limits and a per-room join throttle only, and room creation is unauthenticated by design, so a platform rate limit is required rather than optional on any publicly discoverable deployment: add a Vercel Firewall rate-limit rule (or the equivalent in your proxy) on `POST /api/rooms` at a few requests per minute per IP, and a looser one across the rest of `/api/`.

## 5. Verify the deployed setup

Create a room, choose **Connect your helper**, download/extract/open the Windows app, create a pairing link, and paste it into the app. Load a torrent you can share and invite a second device on a different network. Each participant enables playback; the host starts after everyone buffers.

For a relay-only data test, set the TURN variables in your local terminal and run `npm run test:relay`. It tests every configured TURN URL separately, forces relay candidates, and checks both bytes and selected candidates. It mints a deliberately short five-minute credential, so a relay clock more than a few minutes fast fails this test while live traffic is unaffected. `turns:` and `?transport=tcp` URLs are skipped — the Node test stack cannot open them. A live relay and network access are required; the test fails if either is missing.

## Local verification of the production build

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3002
```

`npm run build` migrates and builds against `TURSO_DATABASE_URL`, or against `.local/rooms.db` when it is unset; set it first to verify a real Turso database. `npm run start` requires `TURSO_DATABASE_URL`, so set `TURSO_DATABASE_URL=file:.local/rooms.db` for this local check. In another terminal, set `TEST_ORIGIN=http://localhost:3002` and run `npm run test:rooms` and `npm run test:remote`. Browser UI QA and cross-network relay verification are separate from the native transfer and API tests.

Deployment references: [Vercel Next.js](https://vercel.com/docs/frameworks/nextjs), [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/quickstart), [coturn configuration](https://github.com/coturn/coturn/blob/master/README.turnserver).
