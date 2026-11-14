# Pilot analytics

The self-hosted dashboard is served by the Handoff backend at **https://handoff.cygantech.com/admin/analytics**. GitHub Pages hosts extension update files, not dashboard data. Collection starts after a server administrator key is configured; older operational history is not backfilled. Extension users receive no additional login, banner or opt-in step. Pilot participants have already been informed by the operator.

## Update your existing server

Run these steps in the **existing repository directory** on the Docker host. Keep the existing Compose project name, `.env`, proxy network and database volume. Back up the existing data volume using your established procedure before updating; the database migration adds tables and preserves registrations and pairings.

```sh
git switch main
git pull --ff-only
openssl rand -hex 32
```

Copy the generated value into the ignored `.env` on your server. Do not paste the real key into chat, Git, tickets or a public configuration file. Set:

```dotenv
PUBLIC_URL=https://handoff.cygantech.com
ANALYTICS_ADMIN_KEY=PASTE_YOUR_GENERATED_KEY_HERE
ANALYTICS_ENABLED=true
ANALYTICS_RETENTION_DAYS=180
```

Then rebuild and verify health:

```sh
./handoff up
./handoff status
curl --fail https://handoff.cygantech.com/healthz
```

For the standalone Caddy deployment, use `COMPOSE_FILE=compose.production.yaml ./handoff up` instead. Preserve any existing `COMPOSE_PROJECT_NAME` setting. For a custom stack manager, pull/rebuild the backend from main and pass the same three `ANALYTICS_*` environment variables to its existing service; retain its existing volume and proxy configuration.

The existing reverse proxy must forward `/admin/*` and `/api/admin/*` as well as `/api/*`, `/ws` and `/healthz` to the backend. No new public port is needed. `PUBLIC_URL` must match the HTTPS origin people use; sign-in rejects other origins. In standalone Caddy, `HANDOFF_DOMAIN` supplies that origin.

Open **https://handoff.cygantech.com/admin/analytics** and enter the key. Normal device tokens cannot sign in. The key is exchanged for an opaque eight-hour HttpOnly, SameSite=Strict cookie, Secure on HTTPS; only loopback development uses HTTP. Sessions are held in server memory, so backend restart/key rotation requires signing in again. Five login attempts per default rate window are permitted per source address. A proxy commonly makes clients share one address. Logout invalidates the session and clears rendered report data.

## Collection settings

- `ANALYTICS_ADMIN_KEY`: required, 32–512 characters. Generate a random 64-character hex value as above. Without a key, collection is off and the admin route reports that setup is required.
- `ANALYTICS_ENABLED`: defaults to true **when a key is configured**. Set false and redeploy to stop new collection while retaining protected access to existing reports. In-flight analytics status is frozen while collection is disabled; it represents the last recorded outcome.
- `ANALYTICS_RETENTION_DAYS`: 180 by default; accepts 1–180. Older usage/events are purged automatically even if collection is disabled. Dashboard footer reflects the configured value.

Stats are kept separately from operational command rows, whose default retention remains one day. Pending workspace payloads are still removed on terminal outcomes. Analytics expiry does not change registrations, pairing or handoff cleanup. Backups and host/proxy logs have their own retention; stored backups are not retroactively changed by database expiry.

## What the numbers mean

- **Handoffs:** logical accepted commands, counted once by command ID, including pending commands. Replayed requests do not add another handoff.
- **Success rate:** applied divided by applied + failed + expired. Pending commands are excluded. Empty terminal history displays a dash.
- **Confirmation time:** time from server acceptance until an applied receiver acknowledgement. Median and nearest-rank 95th percentile exclude failed/expired/pending commands and website loading time.
- **Active browsers:** distinct installations involved as sender or destination in accepted handoffs in the selected range, not unique people or open/connected browsers.
- **Modes and versions:** new extension clients report the selected whole-window/current-tab mode and extension version/platform. A one-tab workspace is not assumed to mean current-tab mode. Older clients show Unknown until metadata is available.
- **Pairings:** newly established peer links by Code/Easy pair. Duplicate code claims against an existing pair and repeated approval requests do not count as new pairings; removing and re-pairing creates a new pairing event.
- **Capture/send/rejected requests:** separate diagnostics, not additions to accepted handoff failures. A request rejected by the server can also be observed as a terminal send failure by the extension; these are separate observations and must not be summed as unique failures. Transient outbound retries are not counted as terminal send failures.
- **Browsers table:** includes current registrations and retained historical installations. Sent/received counts, outcomes and last activity use the selected date range. Never means no accepted handoff in that range. Disconnect redacts the retained name to Removed browser; a fresh registration is a separate installation.

Ranges default to the last 30 calendar days including today in **America/Chicago**, with 7/30/90/180-day and custom ranges. Calendar grouping respects daylight-saving changes. Outcomes belong to the date/range when the command was accepted, even if confirmation arrives later. The chart has an accessible exact-value table. Search/pagination is applied to browser rows. CSV exports use the selected date range, and browser CSV also uses the current table search; daily dates use Chicago, browser `lastActivityUTC` is ISO UTC, and potentially executable spreadsheet cells are escaped.

## Data boundaries and compatibility

Analytics copies only installation references, configured browser names, version/platform, timestamps, tab counts, mode, outcome and bounded diagnostic categories. It never copies workspace URLs, page titles/content, account emails, discovery keys, bearer/admin/session secrets or raw browser error messages. Device names are displayed as configured and can contain personal information chosen by the operator/user; they are restricted to the authenticated dashboard.

The extension negotiates analytics support in the background. Older backends continue receiving the original handoff body; new backends can count legacy handoffs with Unknown client metadata. Event upload does not occupy the normal handoff queue. The local retry queue is scoped to a backend/registration, bounded to 100 events and 24 hours, deduplicated across retries, and cleared on disconnect. Analytics failure must not prevent a handoff. Server recording is best-effort on a database error and logs only a generic analytics persistence error, without request data.

## Verification and troubleshooting

Confirm an enrolled test device has extension **0.2.4**, send one handoff, then reload the dashboard. Updating the extension feed does not deploy the backend or configure your key. No previous statistics can be recovered beyond data actually collected after enablement.

If sign-in fails, check the key and exact `PUBLIC_URL`/proxy origin, then allow the login rate window to reset. If assets are unavailable, rebuild the backend rather than copying only its entrypoint: `dist/server/admin` is part of the server build. Keep the dashboard on trusted HTTPS. Do not put an admin key in a URL or distribute it to extensions.

Development: `npm run check`, `npm run test:e2e`, `npm run test:analytics`, `npm run test:managed-browser`, and `npm run test:docker`. `scripts/admin-browser-smoke.mjs` additionally tests dashboard error/empty/expiry/contrast cases with deterministic API fixtures; `test:analytics` uses real sessions and SQLite reporting. Local Docker may need registry connectivity to resolve the existing `docker/dockerfile:1` frontend before application build begins.
