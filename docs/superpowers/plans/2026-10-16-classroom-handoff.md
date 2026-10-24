# Classroom Handoff Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with independent component ownership and integration review.

**Goal:** Deliver the complete secure browser workspace handoff demonstrator.
**Architecture:** Shared validated protocol, Node/SQLite HTTP+WebSocket backend, MV3 extension with durable restoration, minimal popup/setup UI.
**Tech Stack:** Node 24+, TypeScript, ws, Zod, esbuild, node:test, Playwright where available.
**Spec:** docs/superpowers/specs/2026-10-16-classroom-handoff-design.md

## Global constraints
- Operate within this empty project workspace and existing permissions; no unrestricted host access.
- Chrome 120+, HTTP localhost only, HTTPS elsewhere; no district-specific configuration or OAuth credentials.
- Apply acknowledgement only after restoration; no cookies/content collection; all handoffs require peer authorization.

## Review focus
- Worker death during restoration must avoid duplicate tabs on replay (restoration tests).
- Moved/unrelated tabs must never be removed (restoration tests).
- Pair code guessing, cross-peer delivery and acknowledgement forgery must fail (backend tests).
- Socket loss after command submission must remain pending until ack/expiry (transport tests).
- Browser/backend restarts must preserve identity without trusting reused window IDs (integration/manual test).

## Tasks and interfaces
- [x] 1. Shared contract and build tooling (root): shared/protocol.ts exports workspace schema/types, device/public command/envelope types, URL/backend validation; package scripts build/typecheck/test/package; contract tests first.
- [x] 2. Backend (backend agent): server/config.ts, store.ts, app.ts, index.ts and tests/server.test.ts. REST /api/devices/register, /api/devices, /api/device, /api/pairings, /api/pairings/claim, /api/peers/:id, /api/handoffs, /api/handoffs/:id; WS /ws first-frame auth, ping/pong and ack. Test auth, codes, peers, delivery, idempotency, expiry, offline/restart, retention and rate limits before implementation.
- [x] 3. Extension engine (extension agent): extension/src/workspace.ts, transport.ts, background.ts and tests/workspace.test.ts. Uses shared schema and REST/WS. Chrome storage journal; one receive queue; managed tab safety. Runtime UI actions fixed in shared/ui.ts. Test capture, groups, pinned, dedupe, failures, interrupted restore and unrelated tabs before implementation.
- [x] 4. Extension UI (UI agent): extension/manifest.json, popup.html, options.html, CSS and src/popup.ts/options.ts. Consumes shared/ui.ts, no direct credentials in popup, user-gesture backend host permission request. Handles setup, pairing, status, handoff acknowledgement and errors. Verify typecheck and rendered flow.
- [x] 5. Integration and deployment (root): integrate all contracts, scripts/build.mjs and package.mjs; Dockerfile, compose.yaml, production Caddy config, env example, README, docs/architecture.md and docs/manual-test.md. Run backend+actual client workflow and Chrome test if possible. Validate deployment configuration, package contents, clean install/build/test/typecheck.
- [x] 6. Independent review: inspect acceptance coverage/security/recovery, fix meaningful issues, rerun affected checks and final full build/test. Record precise verification and manual limitations in docs/verification.md. Deliver links and instructions; mark goal complete only once no implementation work remains.

## Execution ledger

- Built shared schemas/contracts, backend, extension engine and UI in parallel with disjoint file ownership.
- User-directed autonomy superseded skill-specific routine spec/plan approval gates. The empty workspace was already isolated and had no existing branch or source to preserve.
- Independent review identified and verified fixes for incoming/outgoing status isolation, restoration deadlines, quota cleanup and worker-death creation gaps. Inert extension marker URLs and durable journals recover tab/window creation boundaries before real navigation.
- Deployment review removed the undeclared system-zip dependency, wired all documented Compose settings and required Caddy email configuration. ZIP creation is deterministic and integrity/extraction checked.
- Added revoked-credential reset and metadata-purged pending-command recovery with race regressions.
- Verification: `npm run check` (42/42 tests); real two-profile Chromium flow; Node24 Alpine image build and isolated Compose persistence smoke; Caddy config validation. Chrome native optional-host prompt, physical devices/ChromeOS, real display behavior and public TLS remain explicitly manual, with full instructions.
- Browser automation initially waited for a new Playwright worker object after stopping an existing Chrome worker; Chrome can reuse the target. Corrected test to observe CDP running status and authenticated peer presence, which verified alarm recovery without receiver UI.
- No code, packaging or test failures remain; the next milestone is a controlled physical-device HTTPS pilot.
