# Classroom Handoff design

## Intent and scope
Build a district-agnostic demonstrator for teachers transferring the current Chrome window to a paired browser. Deliver a working MV3 extension, self-hosted backend, reproducible package, Docker deployment, tests, and two-device instructions. The user explicitly authorized autonomous design and execution, so routine design/plan approval gates are waived by that instruction. The workspace is empty; implementation stays here without requiring host-wide access or a separate worktree.

## Decisions
Use Node 24 LTS, TypeScript, built-in SQLite, HTTP and `ws`, with shared Zod validation. SQLite avoids a separate database service and persists registrations, pairings, and command state across restarts. Use one-time expiring random pairing codes rather than Google identity (no OAuth setup; an email never proves identity). Direct symmetric peer links authorize each sender/receiver pair; a third device pairs with the peers it needs.

An alternative is OAuth plus a hosted push service, which adds tenant configuration and external dependencies. Polling alone is simpler but increases latency and battery/network use. Authenticated WebSockets plus Chrome alarms provide prompt delivery and recovery without third-party infrastructure.

## Protocol and security
Registration returns a random device bearer token once; only its SHA-256 hash is stored. Pair codes have 72 bits of entropy, expire in five minutes, are single use, and are rate limited. Pairing must be deliberately initiated on one trusted browser and claimed on another. Tokens travel in Authorization headers or a WebSocket authentication frame, never URLs. Production requires HTTPS/WSS through Caddy; localhost HTTP is supported for development. Validate bounded JSON, HTTP(S)-only page URLs without embedded credentials, tab count, group metadata, command ownership and expiration. No page contents/cookies are collected. The trusted backend sees workspace URLs during delivery and deletes payloads on completion/expiry; bounded metadata retention supports status recovery. Peer removal and local device reset/revocation are supported. Restrict local credentials to trusted extension contexts.

## Restoration and delivery
Capture current normal window tabs in browser order, active selection, pinned flags, and tab group title/color/collapsed state. Skip restricted URLs with a warning; normalize active fallback. Receiver stages a new set of tabs in its dedicated window, restores pinned order, groups and active tab, then removes only previously recorded managed tab IDs still in that window. Untracked tabs and unrelated windows survive. Persist a receive journal and completed command IDs; recover interrupted work and deduplicate redelivery. Never acknowledge applied until Chrome API calls complete. Page loading or website sign-in is outside this acknowledgement.

Offline targets reject immediate sends explicitly. A command accepted while online is durably pending and redelivered after reconnect until its short expiry; do not replay expired commands. Sender shows pending until an applied/failed/expired acknowledgement. Commands use client request IDs for retry safety. Keep at most one pending command per destination to prevent stale interleaving. Connection freshness depends on heartbeat, with finite stale timeout. Restart loses socket presence but retains device identity/links and live commands.

## User interface
Popup: destination list with presence, preferred selection, Handoff button, progress and warnings, compact setup link. Setup page: backend URL, recognizable device name, register, generate/enter pairing code, peer removal, rename, reset. Optional backend host permission requested only for the chosen origin. No remote scripts or content scripts. Chrome 120+ floor supports 30-second recovery alarms.

## Verification and deliverables
Test validation/serialization, secure authorization/pairing/expiry/restart and actual HTTP/WebSocket flow. Test Chrome restoration and retry safety using a stateful API test harness; run an actual two-profile Chromium extension end-to-end if the sandbox supports it. Document exact executed checks and physical-device/browser/ChromeOS/TLS manual checks separately. Build artifacts/classroom-handoff-extension.zip and unpacked extension; deliver Docker Compose for localhost and Caddy HTTPS deployment plus architecture, security/limits and manual acceptance checklist.
