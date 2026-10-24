# Classroom Handoff

**Testing through Google Admin?** Use the [managed deployment guide](docs/managed-deployment.md) and [hosted installation/update page](https://cygantech.github.io/classroom-handoff/). The signed managed release is force-installed by ID/custom update URL; it does not need Developer mode. GitHub Pages hosts installation files; the backend still runs on your HTTPS Docker host.

Send the current Chrome window to a paired classroom browser. The receiving extension opens the workspace automatically in a dedicated window, including tab order, active selection, pinned tabs and supported groups. Both installations use the same extension; either can send or receive.

This is a self-hosted proof of concept with one-time device pairing. It needs no Google OAuth credentials, paid services, school domain, or Chrome Web Store publication. Existing website sign-ins on the receiving browser continue to work naturally.

## Quick start on one computer

Requirements: Node.js 24 or newer, npm, and Chrome 120+; Docker Engine with Compose v2 for container deployment. Use two **separate Chrome profiles** (or two devices), not two windows of one profile. Each profile must install the extension independently. Backend-only deployment with the supplied extension ZIP needs Docker/Compose; Node/npm is needed when rebuilding or developing locally.

```sh
npm ci
npm run check
cp .env.example .env
docker compose up -d --build
curl http://localhost:8787/healthz
```

`npm run check` typechecks, runs automated tests, builds both components, smoke-tests the built backend and packages the extension. The command generates `artifacts/classroom-handoff-extension.zip`; extract it before loading. Generated developer artifacts are not committed to Git. For Google Admin use the separately signed package on the hosted managed installation page. The reproducible unpacked build is `artifacts/extension/`. The ZIP is an unpacked extension distribution, not a signed CRX.

For development without Docker, use `npm run dev` instead. Defaults are `127.0.0.1:8787` and a persistent `.data/` directory. Node does not load `.env` automatically: export the values you need, or run `node --env-file=.env --import tsx server/index.ts`. No secrets are required in `.env`.

## Install and pair

1. On each Chrome profile, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted ZIP directory containing `manifest.json` (or `artifacts/extension`). Pin Classroom Handoff to the toolbar.
2. Open the extension → **Device setup**. Enter `http://localhost:8787` for the local example and a recognizable name, such as “Teacher laptop” or “Room display”. Click **Connect browser** and allow access to the chosen server when Chrome prompts.
3. On the first browser create a pairing code. On the other browser enter it and pair. Codes are single use and expire after five minutes. Share them only with the intended receiver; pairing grants automatic incoming handoffs in both directions.
4. Confirm both browsers show the other as **Online**. Choose a destination in the popup once; it is remembered.

For two physical devices use a reachable **HTTPS** backend URL. `localhost` on each device refers to that device, so it cannot connect two computers. Do not expose the development HTTP port on the LAN. Pairing is independent of the extension ID, so separately loaded installations work.

## Demonstrate a handoff

Open five ordinary HTTP(S) website tabs in a normal window on A, select the tab you want to present, open the toolbar extension, choose B and click **Handoff**. B opens a dedicated handoff window without opening its popup or accepting a per-transfer prompt. A shows **Waiting** until B confirms that Chrome created the workspace, then **Workspace opened**. Website loading, permission dialogs and successful website sign-in are separate from this acknowledgement.

Try pinned tabs and two named, colored groups. Change the source window and send again: B replaces the tabs it previously managed, while unrelated windows and untracked tabs are preserved. Tabs deliberately moved out of the managed window are preserved too. Disconnect B to see an offline destination; reconnect it before sending again. An already accepted command interrupted by a disconnection retries until its two-minute expiry.

See [the complete manual acceptance procedure](docs/manual-test.md) for tests A–G and failure/recovery cases.

## Linux Docker deployment with HTTPS

1. Point a DNS name at the Linux host. Permit inbound TCP 80/443 (UDP 443 is optional for HTTP/3). Ensure both browsers can reach that name and trust its TLS certificate.
2. Copy `.env.example` to `.env`, set `HANDOFF_DOMAIN` to that DNS name and `ACME_EMAIL` to an operator email.
3. Start the **standalone** production file:

```sh
docker compose --env-file .env -f compose.production.yaml config --quiet
docker compose --env-file .env -f compose.production.yaml up -d --build
curl https://YOUR_HANDOFF_DOMAIN/healthz
```

Caddy obtains and renews certificates and proxies WebSockets. The backend port is private to the Docker network; its SQLite database lives in the `handoff-data` volume. The container runs as an unprivileged user with a read-only root filesystem. Configure both extensions with the same `https://...` origin. No path prefix is supported. Public certificate issuance needs working DNS and external reachability; for a private network provide an HTTPS proxy with a certificate trusted by both devices.

The local Compose file binds only the host loopback. Do **not** combine it with the production file; the latter is complete on its own. For an existing TLS proxy route both `/api/*` and `/ws` (WebSocket upgrade) to the backend, retain `/healthz`, and keep the upstream private. `PUBLIC_URL` must be an HTTPS origin outside loopback. The server assumes TLS termination at this trusted proxy; setting `PUBLIC_URL` does not itself enable TLS.

```sh
# Local logs / stop (preserves registrations)
docker compose logs --tail=100 backend
docker compose down
# Production equivalents include -f compose.production.yaml
```

Back up the database volume with the backend stopped. Restrict backup access: it contains device records and may contain pending workspace URLs. Restore to one backend instance; this POC is not a multi-replica service. Removing the volume destroys pairings and status history. Never use `down -v` unless that reset is intended.

## Configuration

All times are milliseconds. Values are read at backend startup. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Node bind address; containers set `0.0.0.0` |
| `PORT` | `8787` | Node listen port; local Compose maps host `PORT` to 8787 |
| `DATA_DIR` | `.data` | SQLite persistence; container `/data` |
| `PUBLIC_URL` | `http://localhost:8787` | Validates deployment origin; HTTPS outside loopback |
| `COMMAND_TTL_MS` | `120000` | Maximum accepted command lifetime |
| `PAIRING_TTL_MS` | `300000` | One-time code lifetime |
| `RETENTION_MS` | `86400000` | Terminal command metadata retention |
| `HEARTBEAT_INTERVAL_MS` | `20000` | Server control heartbeat interval |
| `HEARTBEAT_TIMEOUT_MS` | `65000` | Stale socket timeout |
| `AUTH_TIMEOUT_MS` | `5000` | WebSocket first-frame authentication deadline |
| `SWEEP_INTERVAL_MS` | `1000` | Expiry/presence maintenance |
| `RATE_WINDOW_MS` | `60000` | Rate limit window |
| `REGISTRATION_LIMIT` | `20` | Registrations per address/window |
| `PAIRING_ATTEMPT_LIMIT` | `10` | Code claims per device/window; address cap is four times this |
| `PAIRING_CREATION_LIMIT` | `10` | Code creation per device/window |
| `REQUEST_LIMIT` | `240` | API requests per device/window and frames per socket/window |
| `MAX_CONNECTIONS` | `1000` | Concurrent WebSocket cap |
| `HANDOFF_DOMAIN`, `ACME_EMAIL` | example values | Production Caddy only |

Rate limits are intentionally modest. A proxy makes all clients share its source address; this protects the public service but may throttle a large simultaneous setup. Tune for a demonstration, not a large fleet. Do not trust arbitrary forwarded IP headers.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
# Optional isolated Compose runtime/persistence check (cleans its own stack):
npm run test:docker
# Optional real two-profile Chromium test, after build:
npx playwright install chromium
npm run test:e2e
```

The real browser test runs the packaged code against a real backend and SQLite database, using temporary profiles and a local fixture website. It automates pairing, actual popup handoff, ordered/pinned/grouped restoration, repeat, offline feedback, profile recovery and backend restart. It does not contact the sample lesson sites or use existing browser profiles. Set `CHROMIUM_EXECUTABLE_PATH` to a compatible Chromium/Chrome for Testing binary if one is already installed, or `E2E_HEADED=1` for a visible run. Chromium is needed for extension side-loading automation; ordinary branded Chrome may disable those command-line flags. Test evidence is saved under ignored `test-results/`; temporary profiles are deleted.

[Verification evidence and remaining manual checks](docs/verification.md) distinguish automated browser evidence from physical-device, ChromeOS and deployed TLS validation. [Architecture and security tradeoffs](docs/architecture.md) describe the protocol, data lifecycle, and next milestone.

## Troubleshooting and limitations

- **Offline / connecting:** Chrome must be running, the extension enabled, and the device awake. Wake/sleep or network change may take up to the heartbeat timeout to settle. Reconnect uses backoff and a 30-second alarm; opening the popup also triggers recovery. Inspect the service worker via `chrome://extensions` if needed.
- **Cannot connect:** verify the backend URL is an origin only, grant the server permission, check `/healthz`, certificate trust, firewall and WebSocket proxy upgrades. HTTP is accepted only on localhost/loopback. A backend restart should not require pairing again if its data volume is intact. If the database was lost or credentials revoked, Disconnect in setup clears the rejected registration so you can register and pair again. Offline disconnect attempts preserve credentials until revocation can be confirmed.
- **Pair code rejected:** use a fresh code from the intended browser on the same backend. Creation invalidates its previous code. Codes expire, cannot be reused, and cannot pair a browser with itself. Wait a minute if rate limited.
- **Stuck waiting:** the receiver may be disconnected or Chrome APIs may have failed. Only an applied acknowledgement produces success. Accepted commands expire after two minutes; an expired/uncertain result is not proof that the receiver did nothing. Inspect B before retrying if an acknowledgement was lost.
- **Tab omitted:** only HTTP(S) URLs without embedded username/password are transferred. Browser settings/new-tab pages, local files, extension pages, `data:`/`javascript:` URLs and credentials in URLs are skipped, with a count warning. The maximum is 100 supported tabs per handoff and 512 KiB per request/frame.
- **Site content differs:** this transfers URLs, not cookies, history, scroll position, media playback, unsaved forms, documents in memory or arbitrary app state. Sites may require sign-in on B; their own security controls still apply.
- **Workspace after a full browser restart:** session ownership of Chrome IDs is deliberately discarded. The next transfer creates a new managed window; a window restored by Chrome from an earlier session remains untouched. Within a running browser, repeated transfers replace only tracked tabs still in the owned window. Editing a managed tab does not detach ownership; move it out before preserving it.
- **Chrome policies / distribution:** managed districts may block Developer mode or side-loading. That needs administrator configuration. The developer ZIP is for unpacked loading. Use the separate signed managed release and Google Admin guide for policy installation. Chrome Web Store publication remains a separate distribution path.
- **Trust and privacy:** paired browsers can open URLs automatically. Use trusted browsers, remove lost peers in setup, and disconnect a retired browser. The self-hosted operator can read pending workspace URLs; transport is encrypted in production but not end-to-end encrypted. Do not hand off sensitive URL tokens to an untrusted display or backend. Local credentials are stored in the extension profile, never synced.
