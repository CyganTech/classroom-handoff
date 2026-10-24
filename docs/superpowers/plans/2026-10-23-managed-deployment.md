# Managed deployment implementation plan

**Goal:** Make Classroom Handoff installable and configurable through Google Admin, with public GitHub source and hosted signed updates.
**Spec:** docs/superpowers/specs/2026-10-23-managed-deployment-design.md
**Execution:** Inline in current project; preserve existing working demonstrator. Prior user delegated independent decisions; no routine approval gate. No delegated implementation.

- [x] Add failing managed configuration/controller tests (policy URL, readonly setup, registration once, unavailable policy handling, permission denial, backend changes).
- [x] Implement managed schema/controller/options changes and rebuild version 0.2.0; all existing tests remain green.
- [x] Add deterministic ZIP helper and signed CRX3 release/verification tooling, stable key/ID, self-host update manifest, admin templates, minimal install page, exact-origin option; test tampering/identity/update consistency.
- [x] Generate local signed public release and protect private material. Add GitHub Pages/release workflow, Google Admin guide, source/CI updates.
- [ ] Verify integrated tests/build/browser and public artifact audit; create repository/push only audited files, enable Pages and verify served update XML/CRX hashes. Document managed-device manual checks and any external blocker accurately.

## Progress
- Inspected current source and researched official Chrome managed schema, Google Admin custom ID/update URL installation and Chromium CRX3 format.
- User confirmed Google Admin / managed Chrome and requested public GitHub hosting. Connected CLI account verified as CyganTech using an authenticated API call; sandbox-only auth status was misleading due to network isolation.
- Backend HTTPS address is not assigned in conversation. Public GitHub can host source/update artifacts, not the WebSocket backend. Keep backend environment-configured and let Admin policy supply its eventual origin.

- 52/52 tests and builds passed. Generic Chrome two-profile E2E and managed build waiting-for-policy browser smoke passed. Chrome native packer matches the same stable ID; public archive contains no private material.
- Managed release initial backend permission covers HTTPS origins so no backend address must be invented. BackendUrl remains required admin configuration; no peer authorization is granted by installation alone.
- Release tooling refuses identity replacement, lower versions or changed bytes under an existing version. Key stays local and excluded; initial public site is signed with the same retained key.

- Required independent review found two P2 issues before initial push. Fixed with failing-then-passing tests: reject signing keys within public output (also follows symlinks), and serialize startup/recovery with manual registration/reset to prevent duplicate identities during policy changes.
- Added verification of the actual committed CRX/ZIP/feed/metadata and archive manifest, in addition to generated-format tests. Public release version is independent from later source development versions; each release's own identity/version/hash must agree.

- Final integrated check: 56/56 automated tests, typecheck/build/runtime smoke/package pass. Managed Chrome smoke rechecked after fixes. Public GitHub repository and Pages workflow configured; initial push/served feed verification remain.
