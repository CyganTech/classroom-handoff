# Deploy Classroom Handoff through Google Admin

This deployment is a **Manifest V3 Chrome extension** installed as a managed extension in **Users & browsers**. It works in the user's normal signed-in Chrome session, on managed Chromebooks and managed Chrome. Do not add the installation page as a website/PWA shortcut: a shortcut cannot capture and reconstruct browser tabs. This is not a kiosk Chrome App.

## Public managed test release

- Public source: https://github.com/CyganTech/classroom-handoff
- Installation/update hosting: https://cygantech.github.io/classroom-handoff/
- Extension ID: `jeclpkblaheplcmfibpagjocmpidmcop`
- Custom update URL: `https://cygantech.github.io/classroom-handoff/updates.xml`
- Current version: **0.2.0**
- Signed package: `site/classroom-handoff-0.2.0.crx`

The public site contains installation files only. The Node/WebSocket backend must still run on a Docker host reachable over trusted HTTPS by both browsers. Use the existing production Compose instructions in README. No real backend address was supplied when preparing this release: set the eventual HTTPS backend origin in Google Admin policy below. No server, device token, or account is hardcoded.

The initial managed test release requests HTTPS host access so the administrator can set the backend afterward, without asking each managed user for an optional host permission. It contains no content scripts or scripting/cookie permission. For a pilot restricted to one known server, build the same extension ID with `--backend-url https://your-server` to narrow its required host permission. Changing host permissions requires publishing an updated version.

## 1. Prepare a small test OU

1. In Google Admin open **Devices → Chrome → Apps & extensions → Users & browsers** (or **Chrome browser → Apps & extensions** in Chrome Enterprise Core).
2. Select a small test organizational unit containing the managed users or enrolled browsers that will participate. For signed-in Chromebook users, installation normally follows their managed user policy; moving only the physical Chromebook into a device OU does not automatically give an unrelated user that extension policy.
3. For managed desktop Chrome, enable browser management for the target OU and ensure the browser/profile is enrolled as required. Do not weaken existing device security settings or turn on Developer mode.
4. Use normal signed-in sessions for this test. Managed guest sessions are ephemeral and can lose device credentials on logout; this guide does not promise persistent pairing across guest sessions. Kiosk installation is not the tested app model.

## 2. Force-install by ID and custom update URL

1. Click **Add (+) → Add Chrome app or extension by ID**.
2. Enter `jeclpkblaheplcmfibpagjocmpidmcop`.
3. Select **From a custom URL** and enter `https://cygantech.github.io/classroom-handoff/updates.xml`. This is the update XML URL, not the GitHub repository page, ZIP URL, or installation page.
4. Save, choose **Force install**, and pin the extension to the browser toolbar if your console exposes that setting. Save/override for the test OU. Accept the extension permissions on behalf of the test users if prompted.
5. Keep your existing extension block/allow policy intact; scope this exact extension to the test OU. If your policies disallow self-hosted extensions, use the administrator's supported exception for this ID/update origin or the Chrome Web Store publication route described below.

Google Admin calls multiple things "apps"; choose the extension-by-ID path. There is no ZIP upload field for force-installing a self-hosted extension. The signed CRX is downloaded by Chrome from its update manifest.

## 3. Apply managed configuration

Select the installed extension and find **Policy for extensions**. Paste the JSON below after replacing the backend origin, or use the installation page's policy JSON generator. The Google Admin format uses `{ "Value": ... }` wrappers; do not paste the OS/browser `ExtensionSettings` example into this field.

```json
{
  "BackendUrl": { "Value": "https://handoff.YOUR-DOMAIN.org" },
  "AutoRegister": { "Value": true }
}
```

| Policy | Meaning |
| --- | --- |
| `BackendUrl` | Required for the managed release. HTTPS origin only, no path/query/credentials. Locks the backend address in setup. The backend TLS certificate must be trusted by Chrome. |
| `AutoRegister` | Defaults to true. Creates one local browser identity automatically when policy and required host access are valid. False lets the user choose a name and connect once at the policy-locked origin. |
| `DeviceName` | Optional initial name for **new** registrations; the user can rename afterward. Omit to generate a distinct “Managed browser …” name. Setting one name at an OU gives all new browsers that same name. |

Do not put a pairing code, bearer token, private signing key, Google password, shared device identity, or backend secret into this JSON. Force installation and policy configure a browser; **secure pairing still authorizes destinations**. Two managed installations receive different identities and remain unpaired until the deliberate one-time pairing step.

Changing BackendUrl does not migrate credentials or peers. The extension stops using the old server and reports that a deliberate disconnect/re-registration is needed. With the old backend reachable, Disconnect revokes the old identity; then the new policy can register a fresh unpaired one. Invalid policies fail closed. When the policy or network recovers, the alarm/startup/UI path retries.

## 4. Verify installation and do the two-device test

1. Sign into the managed user/profile on A and B. Open `chrome://policy`, click **Reload policies**, and verify extension installation/configuration has no errors. Allow policy propagation; a restart/sign-out/sign-in may be required in the managed environment.
2. Open `chrome://extensions`. Classroom Handoff should be present with the expected ID/version and installed by policy. Developer mode is not required.
3. Open the toolbar extension → **Device setup**. The backend address should be locked and marked managed. With AutoRegister true the browser should already have a distinct device ID. Rename A “Teacher laptop” and B “Room display”.
4. Create a pairing code on A, enter it on B, and confirm each sees the other Online. Close B's setup page/popup, but leave Chrome open and the device awake.
5. Open five ordinary HTTP(S) lesson tabs on A. Select the third, optionally pin the first and create two named colored groups. Open the extension → select B → Handoff. B should reconstruct the workspace automatically; A reports success only after B acknowledges.
6. Modify A and hand off again. Confirm B replaces only its managed tabs, preserving unrelated windows/tabs. Disconnect B and verify offline feedback. Reconnect/restart B/backend and repeat.

The full acceptance checklist remains [manual-test.md](manual-test.md). Google Admin delivery, managed Chromebook policy behavior, the actual network/TLS and physical classroom display need validation in your environment; a developer-profile test does not prove those administrative controls applied.

## Hosting and network requirements

Allow the managed browser's extension updater to reach `https://cygantech.github.io/classroom-handoff/` (update XML and versioned CRX). Allow HTTPS/WSS to the separate backend origin. Neither install files nor update requests should require an interactive login, cookie, or Basic Auth. The update and CRX identity/version must match. Public source and signed packages are safe to distribute; the signing private key and pending backend data are not.

GitHub Pages does not run Node, SQLite or WebSockets. A public repository also does not automatically create a persistent backend server. Start `compose.production.yaml` on your own Linux Docker host or another appropriate container host, assign DNS/trusted TLS, then use that origin in the policy.

## Publish an update without changing the ID

The private key generated for this release is local at `.signing/classroom-handoff.pem` with restrictive permissions, ignored by Git and Docker. **Back it up securely.** It is not in the public repository or site. Losing it prevents signing updates for this ID; a different key creates a different extension and cannot update enrolled devices. Do not regenerate it for each version.

1. Increase `version` in `package.json`, the root package-lock version and `packages[""].version`, and `extension/manifest.json` (for example, `0.2.1`). Chrome requires a higher version for an update.
2. Run `npm ci && npm run check`.
3. Reuse the original key:

```sh
npm run release:managed -- \
  --key .signing/classroom-handoff.pem \
  --update-base-url https://cygantech.github.io/classroom-handoff/
# To constrain host access, add: --backend-url https://your-backend-origin
```

4. Review/commit only public `site/` files and source changes, then push main. The Pages workflow publishes the directory. Keep older versioned CRXs available while clients update. Do not overwrite an already published version's CRX with different bytes; increment the version first.
5. Check the served updates.xml and release.json and confirm a test managed browser receives the new version with the **same ID**, registration and pairings. Chrome polls updates periodically; do not promise instant fleet updates.

`npm run release:managed -- --init-key ...` is only for a brand-new independent deployment identity. The tool refuses to overwrite a site's published ID with a different key.

An optional **Build signed managed release** Actions workflow can use the original PEM as the repository secret `EXTENSION_SIGNING_KEY`. Set that secret yourself through GitHub's secure UI or CLI stdin; never commit it or paste it into an issue/chat. The workflow refuses to create a new key and emits a **public-files artifact for review**, not an automatic public release. The Pages workflow requires no signing secret. Local signing is sufficient and keeps the private key off GitHub entirely.

For rollback, publish the prior working code under a **newer** version, using the same key. Do not expect Chrome to install a lower version. Removing the force-install policy may uninstall the extension and erase its local identity; users will need fresh pairing if that happens. Preserve the backend volume across updates.

## Chrome Web Store alternative

If your environment requires store-hosted extensions, upload an appropriate ZIP through your organization's Chrome Web Store developer account, complete its publication/review flow, and use the assigned Store ID in Google Admin. Store enrollment/review and the final Store identity cannot be fabricated from a self-hosted CRX. Do not assume this self-hosted ID is the Store-assigned ID. The managed schema and handoff functionality can be retained, but rebuild the manifest/update settings for Store distribution. This release is prepared for the documented self-hosted custom-URL route.

## References

- [Google: view/configure apps, add by ID and custom URL](https://support.google.com/chrome/a/answer/6177447?hl=en)
- [Google: force-install apps/extensions](https://support.google.com/chrome/a/answer/6306504?hl=en)
- [Chrome managed storage schema](https://developer.chrome.com/docs/extensions/reference/manifest/storage)
- [Chromium: extension policy formats](https://www.chromium.org/administrators/configuring-policy-for-extensions/)
- [Chrome self-hosted packaging/update protocol](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
