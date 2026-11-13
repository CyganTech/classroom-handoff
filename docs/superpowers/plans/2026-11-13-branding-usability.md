# Classroom Handoff branding and usability update

Approved plan: implement the red/neutral window-and-arrow concept; System/Light/Dark themes; saved current-tab checkbox with existing receiving replacement; platform-based stable names and narrowly scoped legacy migration; signed 0.2.3 through existing feed.

Reference: /Users/jacob/.codex/generated_images/01a1d2e2-34c8-7832-9c6f-62b231d47ac4/exec-07ec2c6e-ac15-4098-9e55-13be7481856c.png

Tasks:
1. Single-tab capture and persisted preferences. Default currentTabOnly=false; omitted request field retains full-window behavior. Unsupported active tabs error without substitution.
2. Naming: OS platform plus four unambiguous random characters persisted locally. User/admin names override. Migrate only unmarked exact legacy Managed browser +8 hex names not matching current policy. PATCH failures retry without blocking. Track new names as generated/custom/policy.
3. Theme/icon pass: SVG source and checked-in 16/32/48/128 PNGs; shared accessible tokens, early system theme, saved override synchronized through storage events. Public installer follows system without extension APIs.
4. Unit/browser/managed-build verification and independent review. Compare approved concept and rendered desktop/mobile light/dark screens, status/dialogs, icons, contrast, and controls.
5. Sign/publish 0.2.3 using existing ID/key/feed; retain old artifacts, verify public hashes/signature and CI. No backend API/protocol or deployment change.

Progress:
- Clean main checkout verified, feature branch codex/branding-usability created in the established workspace.
- RED: current-tab capture failed on full-window content, unsupported active page substitution, and 100-tab bound. GREEN: new capture tests pass.
- Naming helper tests failed before module creation and now pass. Preferences and migration integration tests added; full verification in progress.
- Tasks 1–4 complete: current-tab capture/preferences, naming/provenance/migration, shared themes/branding/icons and public installer implemented and verified.
- Full check: 93/93 tests; real two-profile E2E, theme synchronization/contrast/mobile/dialog checks, managed browser smoke and local public installer QA passed. Approved concept and rendered screenshots inspected.
- Review fixes: stalled rename must not occupy the action queue; initialize defaults single-flight; serialize migration's local commit with reset without awaiting it from the name queue. RED→GREEN regressions and reviewer independent naming/managed test run confirm fixes; no deferred material findings.
- Release: signed 0.2.3 prepared with the original key, ID and feed, retaining earlier public packages. Source and public feed publication/live verification follow the approved delivery plan.
