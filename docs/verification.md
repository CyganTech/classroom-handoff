# Verification record

Verified on 2026-10-16 (America/Chicago) in the project workspace. Browser automation used isolated temporary profiles, not the operator’s existing Chrome data. Browser plugin was unavailable; regular Playwright was used. No handoff transport was mocked in the real browser run.

## Executed checks

- Clean locked dependency install: `npm ci --offline --cache .npm-cache --no-audit --no-fund` succeeded after the initial scoped registry download. The lockfile is supplied for fresh `npm ci` installs.
- `npm run check`: TypeScript, automated tests, backend/extension builds, built-backend runtime smoke, and deterministic extension ZIP packaging passed. **42/42 tests passed**, with zero skipped or failed tests.
- `docker compose config --quiet` and production configuration with example domain/email passed. Advanced environment overrides were checked in rendered configuration; missing production email now fails early.
- `docker compose build backend` built the Linux ARM64 Node 24 Alpine image successfully on Docker Desktop. `npm run test:docker` started a temporary Compose stack, verified published health, uid 1000 execution, writable SQLite under read-only root, authenticated API and credential persistence across container restart, then removed its own stack/volume. It rereads the dynamic host port after restart.
- Caddy 2 Alpine `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` returned **Valid configuration**. Validation did not start a public endpoint or issue a certificate.
- ZIP integrity: Python `zipfile.testzip()` found no corrupt entries; every archived file matched the unpacked build. Repacking produced identical SHA-256. The ZIP contains the manifest at its root and all required JavaScript/HTML/CSS, including staging.html. Maps are excluded from ZIP; the unpacked build includes source maps.

## Automated coverage

Tests exercise workspace URL/order/pin/group validation; HTTPS origin rules; registration credential hashing; single-use, expired and self-pairing codes; peer isolation; unauthenticated/mismatched/stale sockets; forged acknowledgements; idempotent request IDs and changed-payload rejection; offline send rejection; reconnect delivery; durable restart; command expiry/late ACK rejection; payload byte removal from SQLite/WAL; revocation/unpairing; rate limits; malformed/oversized HTTP and WS messages; delivery-envelope size limits; REST error propagation and socket reconnection.

The stateful Chrome API tests cover unsupported URLs, selection fallback, group reconstruction, repeat/moved/untracked-tab preservation, absent grouping warnings, API failures, duplicate receipts, stale numeric IDs after a full browser restart, saved staging/commit recovery, quota failures and worker death between Chrome creation and journal persistence. Inert marker tabs/windows make those creation gaps discoverable. Deadline checks roll back expired staging. Background tests isolate incoming status from outgoing progress, preserve credentials when offline revocation cannot be confirmed, allow local reset after an invalid-credential 401, and turn a purged pending status into an explicitly unconfirmed expiry without overwriting newer commands.

## Real browser integration

`npm run test:e2e` with the installed Chrome for Testing 149.0.7827.55 and Playwright used two separately stored installations, a real Node/SQLite backend, real HTTP/WebSocket traffic and real Chrome tab/window/group APIs. The fixture lesson website was a local HTTP server.

The run verified registration, single-use pairing, online presence, the popup Handoff button, five ordered tabs, active tab, pinned flag and two named colored groups (including an inactive collapsed group). The receiving extension UI was closed. Repeated transfers replaced managed tabs, kept an unrelated tab, and continued after an idle interval longer than the 30-second worker idle window. Offline receiver status disabled the button; an explicit send request failed without success. A forced receiver service-worker stop recovered through its alarm with the receiving UI closed, retained the same managed window, and resumed repeated handoff. Browser profile restart retained identity, and backend restart retained pairings and resumed applied transfers.

The test pre-grants only its temporary backend origin through Chrome’s native extension settings API because the native optional-host permission bubble is outside DOM automation. It does not bypass backend registration/pairing/authorization or substitute fake handoff responses. The native permission prompt itself is a manual validation item.

The UI also passed separate rendered checks for setup, pairing, pending/applied/offline/welcome states and 1100px/390px setup and 380px popup layouts. These UI-only checks used mock runtime state; they are supplementary to the real integration run. No extension page runtime errors or horizontal overflow were observed. Browser evidence is under ignored `test-results/`.

## Manual validation still required

- Two physical devices across the actual network, especially a Chromebook and classroom display.
- Current supported branded Chrome/ChromeOS, district extension policies, Developer mode/managed distribution and native host-permission prompts.
- Display focus/OS behavior, real lesson website sign-ins, site loading, downloads/media/autoplay and destination site policies.
- Actual sleep/wake, Wi-Fi/proxy changes, battery/resource behavior and Chrome alarms under power management.
- Public DNS, trusted TLS certificate issuance/renewal, firewalls and production proxy behavior on the intended Linux host. Caddy syntax validation is not a live deployment test.
- Linux x86-64 image build/runtime (the executed Docker host is ARM64), operator backup/restore and long-duration pilot behavior.

Follow [manual-test.md](manual-test.md) for acceptance tests A–G. Full browser restarts deliberately preserve old Chrome-restored windows and start a new managed window, because numeric ownership IDs cannot safely cross browser sessions. Applied means browser API completion, not page readiness. Lost acknowledgement can produce an expired/uncertain sender result even after tabs opened. No organizational identity, end-to-end payload encryption or enterprise fleet administration is claimed.

## Managed deployment update — 2026-10-23

- `npm run check` passed **52/52 tests**, TypeScript/build, built-backend runtime smoke and developer ZIP packaging after managed policy support was added.
- The actual two-profile Chromium handoff/repeat/offline/alarm-driven worker recovery/browser+backend restart test passed again with the updated managed-storage schema present.
- Managed policy/controller tests cover one-time distinct registration, AutoRegister false, policy origin lock, invalid policy refusal and stopping an incompatible existing backend without silently deleting identity.
- CRX3 tests verify a complete archive signature with the developer SPKI identity, independent RSA verification, tamper rejection, deterministic ZIPs, safe archive paths and published release identity/version immutability.
- Chrome's own command-line packer accepted the managed manifest/signing key and produced the same extension ID as the public CRX3 package: `jeclpkblaheplcmfibpagjocmpidmcop`.
- `npm run test:managed-browser` passed against the actual managed release contents: Chrome-loaded managed schema, stable ID, locked backend field, blocked registration until administrator policy arrives and no extension page runtime errors. The screenshot was inspected.
- Public ZIP entries were integrity checked and scanned for private-key material; signing material is ignored by both Git and Docker. No device credentials or pending database contents are part of the public source/site.

These checks do not claim Google Admin force-installation has already happened on an enrolled Chromebook. Apply the test-OU policy, configure the separate HTTPS backend origin, and perform the managed acceptance procedure in managed-deployment.md. The public update feed hosts installation artifacts, not the Node/WebSocket service.

Final pre-publication review reproduced and fixed two managed-release issues: key paths inside public output (including symlinks) are rejected before key creation, and policy recovery is serialized with manual setup/reset so a policy change cannot issue a second registration while setup is pending. Both regressions failed before their fixes and passed afterward. The final full suite is **56/56 passing**, and the public CRX/ZIP/feed/identity/manifest consistency is part of that suite. The finalized managed browser smoke passed again. The signing key remains local and excluded from the public commit.

Public deployment verification: [Pages deployment](https://github.com/CyganTech/classroom-handoff/actions/runs/40050618692) succeeded, and [GitHub CI](https://github.com/CyganTech/classroom-handoff/actions/runs/40050618687) passed the56-test suite, Node24 build/runtime smoke, actual two-profile browser E2E, Compose configuration and Linux Docker image build. The deployed update manifest (including Chrome-style query parameters) and CRX returned HTTP200; the CRX Content-Type is application/x-chrome-extension and its signature/hash/ID matched local release metadata. The live installation page also passed invalid-HTTP rejection, correct policy JSON generation, JSON download and runtime-error checks. This updates the earlier Linux build coverage; actual enrolled Chromebook rollout and the operator's backend network/TLS are still manual.

## Simplified Docker deployment — 2026-10-23

- `npm run check` passed **64/64 tests**, typechecking, backend/extension builds, built-backend runtime smoke and extension ZIP packaging. New tests cover setup from another directory, minimal configuration, proxy options, existing configuration protection, malformed input, failure diagnostics, safe stop, real Git fast-forward/dirty/divergent updates, executing the newly downloaded helper, and a server-only build without extension sources.
- `npm run test:docker` exercised the actual helper in its own temporary Compose project: setup with an external Docker proxy network, health, a separate container reaching `http://classroom-handoff:8787/healthz`, uid 1000 execution, authenticated registration, forced container recreation, cached rebuild through `up`, and `stop`/`up`. The original credential remained valid throughout. The test removed only its own containers, volumes and network.
- All three Compose configurations validated: default, standalone Caddy with example domain/email, and default plus external proxy network. Docker now compiles only backend sources; complete typechecking remains part of `npm run check` and CI.
- The actual two-profile Chromium E2E passed again: registration/pairing, five-tab handoff, ordering/active/pinned/groups, idle presence, alarm-driven worker recovery, repeat/preservation, offline failure, and browser/backend restart.
- Fresh review identified malformed hostname acceptance in setup. Invalid IPv4 and DNS-label regression inputs failed before the fix, then passed after strict validation was added. No other material review findings remained. The signed extension/site files were unchanged.

The helper checks container health; actual server DNS, HTTPS certificate trust and reverse-proxy WebSocket behavior still need the operator's public `/healthz` check and two-device pilot. Enrolled ChromeOS installation remains manual validation. Deployment changes intentionally retain the existing Compose project/volume naming and require no registry credentials or signing key on the server.
