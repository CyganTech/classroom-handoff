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
3. Choose **Pair another browser** in the popup. Under **Use a code**, create an eight-character code such as `K7MP-4RTX`, copy it, and enter it on the other browser. Codes are single use and expire after five minutes. Existing older codes remain valid until expiry. Share codes only with the intended receiver; pairing grants automatic incoming handoffs in both directions.
4. Confirm both browsers show the other as **Online**. Choose a destination in the popup once; it is remembered.

For two physical devices use a reachable **HTTPS** backend URL. `localhost` on each device refers to that device, so it cannot connect two computers. Do not expose the development HTTP port on the LAN. Pairing is independent of the extension ID, so separately loaded installations work.

## Automatic suggested browsers and Easy pair

Open Device setup to see **Suggested browsers** automatically. Both installations must use the same Handoff server and the same primary signed-in Chrome profile account; a Google account signed into a website alone does not qualify. No extension login or Google OAuth flow is needed. ChromeOS primary-profile support must be validated on actual enrolled devices. To turn suggestions off, expand **Advanced settings** under **This browser** and uncheck **Suggest browsers automatically**.

An online, unpaired installation appears under **Suggested browsers**. Click **Easy pair**, then open Handoff on the other browser and choose **Accept** or **Decline**. Requests expire after five minutes; sending a request alone grants no access. Once accepted, pairing behaves exactly like code pairing. If no account is available, permissions are denied, or suggestions cannot reach the server, use a code.

Version 0.2.2 enables suggestions once for new and existing installations, including browsers that had suggestions disabled in 0.2.1. An off choice made afterward is preserved across restarts and later updates.

The extension needs Chrome's `identity` and `identity.email` permissions to read primary-profile information when suggestions are enabled. It sends a SHA-256 matching key derived from the stable account ID and backend origin. The email stays local and is never included in discovery requests. The key is persistent, pseudonymous account metadata visible to the server operator; it is a discovery hint, not verified Google authentication. Approve only a browser you recognize. Turning suggestions off, changing the profile account, or disconnecting clears membership and pending requests when the extension next reaches the server. Existing peer links remain until removed explicitly. Identity is rechecked at startup, sign-in changes, recovery alarms and UI polling; sleeping/offline browsers cannot publish a change immediately.

The discovery backend introduced with 0.2.1 is required; the automatic-suggestions update in 0.2.2 requires no additional backend update. Additive SQLite tables preserve registrations and peers; old extensions continue using their existing handoff protocol. Managed updates use the signed package and update feed linked above. Publishing source alone does not deploy a backend. Releases retain the existing signing key and extension ID; identity permission behavior still needs validation through Google Admin.

## Demonstrate a handoff

Open five ordinary HTTP(S) website tabs in a normal window on A, select the tab you want to present, open the toolbar extension, choose B and click **Handoff**. B opens a dedicated handoff window without opening its popup or accepting a per-transfer prompt. A shows **Waiting** until B confirms that Chrome created the workspace, then **Workspace opened**. Website loading, permission dialogs and successful website sign-in are separate from this acknowledgement.

Try pinned tabs and two named, colored groups. Change the source window and send again: B replaces the tabs it previously managed, while unrelated windows and untracked tabs are preserved. Tabs deliberately moved out of the managed window are preserved too. Disconnect B to see an offline destination; reconnect it before sending again. An already accepted command interrupted by a disconnection retries until its two-minute expiry.

See [the complete manual acceptance procedure](docs/manual-test.md) for tests A–G and failure/recovery cases.

## Deploy on your server with an existing HTTPS proxy

Only Git, Docker Engine and Compose v2 are needed on the server:

```sh
git clone https://github.com/CyganTech/classroom-handoff.git
cd classroom-handoff
./handoff setup https://handoff.example.org
```

Replace the example with your HTTPS origin. Point your existing proxy at `http://127.0.0.1:8787`, enable WebSocket support, and check `https://handoff.example.org/healthz`. For a **containerized proxy**, append `--network YOUR_PROXY_NETWORK` and use `http://classroom-handoff:8787` as its upstream. For a proxy on another server, append `--bind YOUR_DOCKER_HOST_LAN_IP` and use that private IP as the upstream.

```sh
./handoff update  # Pull changes and rebuild; wait for a healthy backend
./handoff up      # Rebuild current local files (useful for quick edits)
./handoff logs    # Follow logs; Ctrl-C exits
./handoff status
./handoff stop    # Keeps pairings and device registrations
```

Setup creates `.env` without overwriting existing configuration. Updates retain the database volume and refuse to overwrite uncommitted Git edits. Backend updates do not need an extension reinstall. See the [short Docker deployment guide](docs/docker-deployment.md) for proxy examples, custom ports, troubleshooting and iteration details.

### Automatic HTTPS with Caddy

If you need the project to provide HTTPS, point a DNS name at the Linux host and permit inbound TCP 80/443 (UDP 443 is optional). Copy `.env.example` to `.env`, set `HANDOFF_DOMAIN` and `ACME_EMAIL`, then start the **standalone** production file:

```sh
docker compose --env-file .env -f compose.production.yaml config --quiet
docker compose --env-file .env -f compose.production.yaml up -d --build --wait
curl --fail https://YOUR_HANDOFF_DOMAIN/healthz
```

Caddy obtains/renews certificates and proxies WebSockets. Its backend port is private to the Docker network. Do not combine this standalone file with `compose.yaml`. Use its explicit `-f compose.production.yaml` for subsequent Compose operations. Public certificate issuance needs working DNS and external reachability.

All deployments use the `handoff-data` volume for SQLite. The backend runs as an unprivileged user with a read-only root filesystem. Back up the database volume with the backend stopped and restrict backup access; it can contain pending workspace URLs. Restore to one backend instance. Removing the volume destroys pairings and status history. Never use `down -v` unless that reset is intended.

## Configuration

All times are milliseconds. Values are read at backend startup. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Node bind address; containers set `0.0.0.0` |
| `PORT` | `8787` | Node listen port; Compose maps host `PORT` to container 8787 |
| `BIND_ADDRESS` | `127.0.0.1` | Compose host interface; use a private IPv4 for a separate proxy host |
| `PROXY_NETWORK` | unset | Existing Docker proxy network when using `compose.proxy.yaml` |
| `COMPOSE_FILE` | unset | Set to `compose.yaml:compose.proxy.yaml` to enable the proxy network |
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
