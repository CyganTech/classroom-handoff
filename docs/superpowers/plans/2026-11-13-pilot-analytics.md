# Pilot analytics implementation

Approved plan: Pilot Analytics Dashboard supplied in the implementation request.

- Automatic server-enabled analytics, no extension notice/opt-in, 180-day retention, no workspace URL/title/email/discovery key/credential/free-form error capture.
- Backend-observed accepted/terminal handoffs and new pairings; bounded authenticated client info and capture/send-failure events, capability negotiation for old backends. Analytics network/storage failures cannot prevent normal handoffs.
- Private /admin/analytics dashboard in the approved red/neutral design, light/dark/system, 30-day default and 7/30/90/180/custom ranges in America/Chicago, per-browser detail, safe daily/browser CSVs.
- Admin key exchanged for opaque 8-hour HttpOnly/SameSite Strict cookies, Secure with HTTPS, origin validation, login limits and logout. Device credentials never grant admin access.
- Additive SQLite migration, retained reports separate from operational payload retention, neutral removed-browser labels, bounded retention/pagination.
- Publish signed 0.2.4 with existing key/ID/feed and retained packages. Operator deploys backend; provide env/key/update instructions and verify health/feed/CI.

Work split: root owns server/config/store/shared schema/auth/integration/tests/release; dashboard agent owns server/admin frontend and build asset handling; extension agent owns extension analytics helper/integration/tests. Fixed report and collector types in shared/analytics.ts.

Progress: implemented backend analytics/admin sessions, approved dashboard, negotiated extension telemetry, additive SQLite tables, tests and operator documentation. Independent backend/security/privacy review completed with no confirmed material findings; retention capped at 180 days. Full check passes 119 tests, real two-profile integration and real dashboard integration pass, and supplementary dashboard contrast/error/mobile checks pass. Signed 0.2.4 locally with unchanged key/ID/feed; signature/hash/package and managed-browser smoke verified. Source branch published and GitHub run 43538244213 passed full checks, real browser tests, Compose and Docker analytics/persistence. Promoting the verified implementation to main/update feed, then verifying public assets. Local Docker frontend resolution stalled before application build; isolated test cancelled/cleaned, actual Docker verification passed in GitHub CI.
