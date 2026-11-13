# Architecture and technical decisions

The extension captures the current normal window and sends a versioned workspace to the self-hosted backend. The backend authorizes the sender/receiver peer link, stores a short-lived command, and pushes it over the receiver’s authenticated WebSocket. The receiver uses Chrome APIs to stage and commit a dedicated workspace and acknowledges the result. Only that acknowledgement changes the sender to success.

```mermaid
sequenceDiagram
    participant A as Sender extension
    participant S as Node + SQLite
    participant B as Receiver extension
    A->>S: POST handoff (bearer, request UUID, workspace)
    S->>S: Validate peer, presence, limits; persist pending
    S-->>A: Pending command ID
    S->>B: Authenticated WebSocket command
    B->>B: Journal, stage tabs, groups, selection; commit
    B->>S: Applied / failed acknowledgement
    S->>S: Terminal status; remove workspace payload
    S-->>A: Command status update
```

## Components

- `shared/protocol.ts`: strict Zod workspace/message schemas and wire types. `shared/ui.ts` defines popup/worker actions without exposing tokens to UI responses.
- `server/store.ts`: synchronous prepared SQLite statements for device credential hashes, direct peer edges, single-use pairing codes, discovery membership, expiring pairing requests and command state. WAL, foreign keys and a unique pending-destination index enforce local consistency.
- `server/app.ts`: HTTP registration/pairing/handoff/status, authenticated WebSocket delivery, presence, acknowledgements, rate limits, expiry, payload bounds and graceful shutdown. `server/config.ts` owns environment settings.
- `extension/src/background.ts`: trusted extension message boundary, persistent configuration/preferences/status and idempotent outbound retry. UI requests are serialized, status updates use a separate serialized queue.
- `extension/src/transport.ts`: REST with deadlines and no credentials in URLs, first-frame socket authentication, schema checks, 20-second application heartbeat and exponential reconnect with jitter.
- `extension/src/workspace.ts`: serialization and a serialized, journaled receive queue. Ownership is in Chrome session storage and receive receipts in local storage.
- Popup and options: local TypeScript/HTML/CSS only. No remote code, content scripts, cookie permission or Google OAuth login. Optional primary-profile discovery uses the Chrome identity API.

## Identity and authorization

Registration creates a random UUID and 256-bit random bearer token. The token stays in `chrome.storage.local` restricted to trusted extension contexts; the backend stores its SHA-256 hash. There is no use of the Chrome profile email as authentication. Two devices pair by deliberately creating and claiming a five-minute single-use code with eight characters from a 32-character alphabet (40 random bits), backed by the existing device/address attempt limits. New codes are displayed as `XXXX-XXXX`; legacy 18-character hexadecimal claims remain accepted until expiry. Code collisions are retried without overwriting another browser’s code. Only symmetric direct peer links can send. For three devices, pair each required sender/receiver relationship separately; pairings are not transitively shared.

WebSockets authenticate in the first text frame within five seconds; tokens never appear in socket URLs. HTTP uses `Authorization: Bearer`. Acknowledgements are accepted only from the command destination. Peers can be removed, and disconnecting an installation revokes its credential and associations. Reset needs a reachable backend so credentials are not silently orphaned (an explicit invalid-credential HTTP 401 permits local reset); loss of all credentials/data requires a fresh registration. There is no administrator account or recovery portal in this POC.

HTTPS/WSS is required for non-loopback deployments. Caddy terminates TLS and forwards privately to Node. The configuration checks allowed origin syntax; it cannot verify the operator’s proxy/network isolation. Anonymous registration is intentional for independently deployable pairing, with rate limits and socket/body caps. Strong user identity, invitations, organizational enrollment, quotas and distributed abuse prevention are later work.

## Optional profile discovery and approved pairing

Discovery is automatic by default in 0.2.2. A versioned local preference migration writes `discoveryEnabled: true` and `discoveryPreferencesVersion: 1` together once for new and legacy installations, including legacy false preferences. Subsequent explicit changes write the marker with the preference; a later restart or update preserves those choices. The off switch lives under collapsed Advanced settings. When enabled, `chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })` reads the primary Chrome profile without OAuth. The extension hashes a versioned tuple of backend origin and stable account ID using SHA-256. Email is used only in local setup text. The account key is persistent pseudonymous metadata, not anonymous data or server-verifiable proof of Google ownership; the server continues to trust only device bearer credentials and explicit receiver approval.

Authenticated APIs:

- `PUT /api/discovery` accepts `{ accountKey: string | null }` (64 lowercase hexadecimal characters, or null to disable). Changing/removing a key transactionally deletes that device's pending pairing requests.
- `GET /api/discovery` returns `{ suggestions: Device[], requests: PairingRequest[] }`. Suggestions are online, matching, unpaired peers only, without account keys. `GET /api/pairing-requests` lists the caller's unexpired requests.
- `POST /api/pairing-requests` accepts `{ destinationId }`, validates enabled matching and target presence, and creates or reuses a pending request for either direction of that pair.
- `POST /api/pairing-requests/:id/accept` or `/decline` requires the named receiver. Acceptance revalidates membership and expiry and atomically consumes the request and creates the same symmetric peer link as manual pairing. Duplicate acceptance fails; a request grants no handoff authorization.

`PairingRequest` includes ID, public source/destination device metadata, and expiry. Requests share the manual code creation/claim rate buckets and five-minute configurable pairing lifetime. Database changes are additive; expiry and foreign-key cascades clean up expired requests and revoked devices. No discovery messages are added to the existing WebSocket protocol.

The background worker rechecks identity at startup, sign-in change, recovery and UI polling; disabling discovery or a changed/missing account clears server membership on the next successful sync. Published membership is recorded locally so failed cleanup retries after reconnection. Discovery failures stay separate from handoff status and leave manual pairing usable. Previously approved pairings survive identity changes or discovery opt-out. Discovery requires the backend introduced with 0.2.1. Automatic suggestions in 0.2.2 change only the extension and need no further backend deployment; publishing source alone does not publish the managed update feed.

## MV3 lifecycle and recovery

Chrome 116 introduced WebSocket activity extending extension worker life. This extension requires Chrome 120+ so its recovery alarm can run every 30 seconds. While connected it exchanges application ping/pong at 20-second intervals; alarms, startup and UI events can reconnect a terminated worker. Persistent credentials, outbound request UUIDs and receive journals survive worker termination. Chrome may delay alarms while a device is asleep: the system does not promise delivery to a sleeping or closed browser.

The backend rejects a known offline destination. Once accepted, a command remains pending, redelivers on reconnect and expires after two minutes by default. There is one pending command per destination. Repeating the same request UUID with identical contents returns the original command; a changed payload with that UUID is rejected. Pending status can be fetched after lost notifications. Terminal metadata remains one day by default; a missing old record is reported as an error rather than presumed successful.

`applied` confirms browser API completion, not website readiness. A lost acknowledgement can leave the sender with an expired/uncertain result even though the receiving tabs opened. This is an honest limit of a distributed protocol; inspect the receiver before resending after an uncertain result. Receipts deduplicate backend redelivery (up to 500 receipts within two days). A send whose HTTP response is lost retries the same UUID for a bounded period instead of inventing a second command.

## Workspace safety

Only HTTP(S) URLs without embedded credentials are captured; unsupported pages produce a count warning. There must be one selected supported tab; the first supported tab is selected if the original active tab was skipped. Limits are 100 supported tabs and 512 KiB per request/delivery envelope. Pinned tabs must lead the workspace; group IDs are remapped to the destination. Titles/colors/collapsed state are restored when grouping APIs are available. Chrome may expand a group containing the active tab. Group sharing/saved group identity, split views and browser history are not transferred.

A receiver stages new tabs in its dedicated window while the previous workspace is still present. Failure before commit rolls back the staged tracked tabs and preserves the old workspace. Commit removes only recorded managed tab IDs which still belong to that window; tabs moved elsewhere and untracked user tabs survive. New tabs initially use inert extension marker URLs containing the live lease and command ID. Their IDs are journaled before navigating to lesson URLs; recovery can discover a marker if the worker dies between tab creation and recording its ID. Initial window creation uses the same marker approach. The receiver never closes arbitrary user windows. A command is acknowledged after commit and its receipt is durable. Grouping errors on supported APIs are failures, not hidden successes; absent grouping support yields a warning.

Chrome numeric IDs are browser-session-specific. The ownership lease lives in `chrome.storage.session`, so a service-worker restart can safely continue using it. A full browser restart clears that lease. Existing windows restored by Chrome are therefore preserved and the next handoff opens a fresh managed window. This can leave one earlier handoff window after a full browser restart, a deliberate preservation tradeoff. Close that old window manually if no longer needed. A moved managed tab is detached by location; editing it in place retains management.

Chrome APIs and storage are not one atomic transaction. The receive journal and receipts recover interrupted staging and commit boundaries, but cannot give a mathematical exactly-once guarantee across every possible browser/storage crash. Tests exercise saved journal phases and API/storage failure boundaries. The UI never treats a server’s mere acceptance as applied.

## Data and operational limits

Device names/IDs, hashed credentials, peer links, pairing-code hashes and command metadata are retained, plus account matching keys for enabled discovery and short-lived pairing-request participants/expiry. Raw profile emails and account IDs are not sent to the backend. Pending payloads contain URLs, pinned/selection flags and group metadata; no page contents, cookies, passwords, screenshots or unsaved form state are read. The backend is trusted with pending URLs, including any query tokens already present in them. This POC is transport-encrypted, not end-to-end encrypted. URLs are removed from logical rows on terminal status and SQLite secure-delete/checkpoint truncates WAL; existing backups, proxy logs and OS snapshots require their own retention controls. Default server logging avoids URLs/tokens/pair codes.

Use one backend process and a persistent local SQLite volume. Back up while stopped, restrict filesystem access, and protect the HTTPS endpoint. Registrations and peer links remain until revoked; expired pairing hashes and terminal command records are swept. No multi-replica coordination, organization isolation, database migration framework or production monitoring stack is implemented.

## Research references

- [Chrome: WebSockets in extension service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) informed the 20-second heartbeat.
- [Chrome: worker lifecycle and Chrome 120 alarms](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) informed persistent state and the minimum browser version.
- [Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs), [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) and [windows](https://developer.chrome.com/docs/extensions/reference/api/windows) define supported capture/restoration APIs.
- [Chrome permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) informed user-gesture server-origin permission requests; [storage](https://developer.chrome.com/docs/extensions/reference/api/storage) defines trusted-context access and session lifetime.
- [Node SQLite](https://nodejs.org/api/sqlite.html) and [ws](https://github.com/websockets/ws/blob/master/doc/ws.md) document the server primitives.
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions) informs separate persistent Chromium profiles. The test grants its disposable backend origin via Chrome extension settings because the native optional-host bubble is outside page automation; manually validate that native prompt on real devices.

## Recommended next milestone

Pilot the demonstrator with two managed district devices through a deployed HTTPS backend. Validate ChromeOS, policies, sleep/wake, proxy/TLS, display focus and website sign-in behavior. Then introduce organizational enrollment and remote device revocation with an audited identity provider, plus an operator view of delivery errors and deployment monitoring, before expanding beyond trusted POC users.
