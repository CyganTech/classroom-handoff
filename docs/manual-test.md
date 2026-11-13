# Two-browser/device acceptance test

Use a teacher laptop/Chromebook (A) and a classroom computer/display (B), or two independent local Chrome profiles. Use Chrome 120+ with the extension enabled in each. For separate computers deploy the HTTPS Compose stack and enter the same reachable HTTPS origin on both. Each machine’s localhost is different. Have ordinary website sign-ins ready on B. A separate screen and a physically sleeping device cannot be proven by an API simulator or two headless profiles.

Record date, extension/backend version, Chrome version/OS, backend origin, proxy and actual result per step. Do not record tokens or sensitive lesson URLs in shared reports.

## A — Initial setup and pairing

1. Follow README’s clean install and build instructions. Load `artifacts/extension` independently in A and B.
2. Open Device setup on A. Enter server origin, name it “Teacher laptop”, connect and approve Chrome’s native server access prompt. Repeat on B as “Room display”. Confirm denial gives a useful error before retrying approval.
3. Create a code on A; confirm `XXXX-XXXX` with eight easy-to-read characters. Copy it and verify the copied feedback. Claim it on B using lowercase and spaces around the hyphen. Confirm both show the other **Online** with the right name, without using a Google password or separate per-handoff login.
4. Try claiming the same code on a third fresh profile: it must fail. Create a new code and let it expire before claiming: it must fail. A fresh unrelated profile must not see other devices.
5. Rename B, verify A updates, choose B in A’s popup and reopen it: destination preference is remembered.

## B — Basic automatic handoff

1. Keep an unrelated window and tab open on B as preservation witnesses. Close B’s extension popup/setup tab; keep Chrome running.
2. In one normal window on A open five ordinary HTTP(S) lesson tabs in a known order. Select the third tab. Open toolbar extension → choose B → **Handoff**.
3. Without touching B, confirm its dedicated window has all five URLs in source order with the third selected, and it receives focus. Verify A waits for confirmation and then reports **Workspace opened**. Confirm unrelated B tabs/windows remain.
4. Check real pages render and destination website authentication works. Sign-in or autoplay prompts are website behavior, outside the URL restoration acknowledgement.

## C — Pinned tabs and groups

1. Pin the first tab. Put tabs 2–3 in “Science” (blue), tabs 4–5 in “Reading” (yellow). Collapse Reading and select tab 3.
2. Send again. Verify one pinned tab first, group membership/titles/colors, collapsed Reading, order and selected tab. A group containing the active tab may expand under Chrome’s own rules.
3. Add a Chrome settings/new-tab/local file tab in A. Send: it must be omitted with a visible warning while supported tabs restore. Try a window with no supported pages: send must fail clearly.

## D — Repeat and preservation

1. Add an unrelated tab inside B’s managed window. Move one previously managed tab to a separate B window. Change A’s URLs/order/selection, remove some tabs, send again.
2. Confirm old tracked tabs still inside the managed window are replaced with the new workspace. The untracked B tab, moved tab and unrelated windows remain. Repeat three times and check tab counts do not grow each time.
3. Close the managed window, send again and verify a fresh managed window appears. Editing an extension-managed tab in place retains management; move it out before preserving it.

## E — Offline and uncertain delivery

1. Disable B’s network or close Chrome. Allow up to 65 seconds for presence to become stale. A must show B offline and prevent a normal send; the backend must reject direct offline sends. No success feedback is permitted.
2. Restore B, wait for **Online**, and send successfully without pairing again.
3. For an accepted in-flight command, interrupt B/backend connectivity immediately after clicking Handoff. A must remain pending, then applied/failed on recovery or expired after two minutes. An expired/uncertain result means no timely acknowledgement, not proof that B did nothing; check B before resending.
4. Sleep/wake both devices and change Wi-Fi. Confirm automatic reconnection and the next handoff work. Closed/disabled/asleep browsers cannot be guaranteed to receive immediately.

## F — Restart and failure recovery

1. Restart the backend container while both Chrome profiles remain open. Wait for reconnection. Names/peer links must persist and a new send must apply without re-pairing.
2. Open `chrome://extensions` → service worker Inspect on B. Stop its worker using DevTools/Chrome worker controls, then close DevTools. Allow the recovery alarm to wake it or reopen the popup. Send again and confirm one workspace, correct final state, no false applied status.
3. Restart B’s entire Chrome profile. Registration/peer links must remain. Send again: a fresh managed window is expected because browser-session ID ownership is discarded; any old window Chrome restored remains preserved.
4. Remove B from A’s paired list. Confirm they disappear and no new handoff is authorized. Pair again. Disconnect B in setup with backend online: its credentials must be revoked; setup must return to registration. Existing windows remain.
5. Test invalid backend origin, invalid code and unreachable server. Confirm clear errors, recoverability and no credentials/URLs in routine server logs.

## G — Clean deployability

1. On a generic Linux Docker host clone/copy this repository, `npm ci && npm run check`, configure `.env` and run either Compose configuration exactly as documented.
2. Confirm health, logs, WebSocket upgrades, persistent volume and non-root backend. For production validate actual public DNS/certificate issuance/renewal and Chrome trust on both devices.
3. Install the supplied ZIP after extracting it, pair two fresh profiles and repeat B–F. No domain, account, district ID or secret should need editing in source code.
4. Rebuild package, check SHA-256, restart containers and verify pairing survives. Back up/restore the stopped database volume to a single instance and demonstrate reconnection.

The automated suite covers validation, authorization, actual HTTP/WebSocket/SQLite delivery and browser restoration/recovery. See verification.md for the exact executed browser tests. Physical devices, ChromeOS, managed installation policies, external TLS and classroom display behavior remain manual acceptance items.


## H — ChromeOS profile discovery and Easy pair

1. On two actual Chrome/ChromeOS profiles with the extension, use the same primary Chrome account and server. Record ChromeOS/Chrome versions and whether installation is managed. Confirm suggestions appear automatically without opening Advanced settings, and manual pairing still works.
2. Remove the manual peer link. Without changing any settings, confirm the browser names appear as online suggestions without any extension login or OAuth flow. A Google account signed in only on a website must not substitute for the primary Chrome profile account.
3. Click **Easy pair** on A. Verify it remains unpaired and cannot send. Open B's popup; verify A's name, expiry and **Accept**/**Decline**. Decline and confirm the request disappears on both after polling. Request again, accept on B, and send an actual handoff.
4. Repeat with different primary accounts and different server origins: neither should suggest the other. Sign out or use a guest profile; manual codes must still work. Close/sleep B and verify it is no longer suggested once presence expires.
5. Request pairing and wait five minutes: no acceptance after expiry. Request again and change the profile account or turn suggestions off before accepting: pending requests must clear after synchronization. Previously approved pairings must remain until explicitly removed.
6. Restart the backend and browser worker. Confirm discovery preferences/pairings survive and pending requests retain their original expiry. Disconnect a browser and confirm its discovery membership and requests are removed.
7. Inspect discovery HTTP bodies and the database in a disposable test environment: only a 64-character matching key is published, never email or raw account ID. Different backend origins must yield different keys for the same account. Avoid copying live account metadata into reports.
8. Verify the new identity permissions on a force-installed, enrolled Chromebook through Google Admin. Browser automation uses controlled identity data and does not establish native ChromeOS account availability or managed permission behavior.


## I — Automatic suggestions upgrade and advanced opt-out

1. Upgrade two existing 0.2.1 installations to 0.2.2, with suggestions previously off on one and on for the other. Confirm matching online browsers appear automatically with their existing registration IDs and peer links preserved.
2. Confirm **Advanced settings** starts collapsed and the main Suggested browsers section has no checkbox. Expand Advanced settings and turn **Suggest browsers automatically** off. Pending requests and membership must clear after synchronization; established pairings and manual codes must keep working.
3. Reload setup, stop/restart the worker, and restart Chrome. The advanced opt-out must remain off. Re-enable it and confirm suggestions return. Future extension updates must preserve this post-migration choice.
4. Repeat with a new installation, a missing primary Chrome account, a different primary account, and an unreachable backend. New profiles discover automatically when eligible; unavailable discovery must still offer manual codes and must never pair without receiver approval.
