# Friendlier pairing implementation

Approved specification: the Friendlier Pairing Implementation Plan in this chat.

1. Shorten manual codes to eight unambiguous characters; retain legacy claims and rate limits. Add collision/expiry/normalization tests.
2. Add opt-in discovery membership and expiring, approved Easy pair requests to SQLite and authenticated HTTP APIs. No handoff protocol changes.
3. Synchronize primary Chrome profile identity through a backend-scoped account-ID hash. Keep email local; clear stale membership and requests on account change/disable/revoke.
4. Add suggestions, request approval, copy feedback, and popup setup shortcut within existing UI styles.
5. Extend browser coverage and documentation, run npm run check and two-profile end-to-end, review, commit, and push codex/friendlier-pairing.

Defaults: discovery disabled initially; five-minute requests; required identity/identity.email permissions, no OAuth; online targets only; additive database migration; backend before extension rollout.

Progress:
- Clean starting checkout verified. Feature branch created. Native socket tests require sandbox escalation.
- Ruling: use requested feature branch in current clean checkout, avoiding an unsolicited worktree.
- Tasks 1–4 complete: code format/legacy support, additive persistence/APIs, profile synchronization and UI implemented.
- Task 5 verified: npm run check passed 75/75 tests; real two-profile Chrome for Testing 149.0.7827.55 E2E passed, including recovery/restarts. Screenshots inspected at desktop and mobile widths.
- Final review: independent reviewer found uncertain-publication cleanup gap. Fixed with a durable pre-publication marker; regression failed on stale membership before fix and passed after. No deferred findings.
- Ruling: use existing installed Chrome through CHROMIUM_EXECUTABLE_PATH rather than download another browser revision. Profile identity is controlled only in the browser test; physical ChromeOS checks remain manual.
- Delivery: commit and publish source on codex/friendlier-pairing. No backend deployment or signed extension release is included.
