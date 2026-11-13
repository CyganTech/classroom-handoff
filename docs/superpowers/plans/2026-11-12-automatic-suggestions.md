# Automatic browser suggestions

Approved plan: Automatic Browser Suggestions, supplied in the implementation request.

1. Enable new and legacy installations once using discoveryPreferencesVersion=1 and discoveryEnabled=true in one storage write. Later explicit opt-outs remain authoritative.
2. Move the control into collapsed Advanced settings, explain automatic matching and local email handling, and preserve manual codes and receiver approval.
3. Verify migration from absent/true/false preferences, opt-out persistence/cleanup, existing failures, and automatic two-profile suggestions without touching controls.
4. Publish signed 0.2.2 with the existing identity/feed; retain old packages and verify public signatures/hashes and CI.

Progress:
- Clean main checkout verified; created codex/automatic-suggestions in the existing checkout, following the established workspace choice.
- Regression tests: six expected failures against old discovery behavior; migration and advanced opt-out implemented.
- No backend APIs or shared UI interfaces changed. No additional backend deployment required.
- Tasks 1–3 complete: automatic preference migration, collapsed advanced control, updated setup/privacy documentation and browser flow implemented.
- Verification: 80/80 tests and full checks passed; two-profile browser E2E and managed-browser smoke passed; signed 0.2.2 package verification passed. Screenshots inspected at desktop/mobile widths.
- Independent review: no material findings or deferred issues. Reviewer sandbox could not bind local sockets; implementer verification ran successfully with the required sandbox permission.
- Release preparation: original signing key/ID/feed retained; versioned 0.2.0 and 0.2.1 public artifacts preserved. Publishing and live verification are the remaining delivery steps.
