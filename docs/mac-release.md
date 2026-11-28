# Developer ID release of 1.0.0

This is a direct-download release, not a Mac App Store submission. Apple's notarization checks signing/security; it is not App Review, a functional approval, or a rights clearance. Nothing in this document authorizes merging, building from a feature branch, or publishing.

## Prepared in source

- Version 1.0.0, stable existing app ID/profile, Electron 45.5.0.
- macOS 13 minimum; separate Apple Silicon/Intel DMG and ZIP targets.
- Developer ID signing required, hardened runtime enabled, app/helper JIT entitlement only, automatic app notarization/stapling. Ad-hoc/disabled signing and missing notarization credentials fail the build.
- Signed DMGs receive their own notarization and stapling, followed by Gatekeeper/ticket verification. ZIPs contain the already stapled app. macOS still uses manual app updates; no `latest-mac.yml` is published.
- Native menus, Command-W/Command-number tab controls, Control-Tab navigation and download/worker cleanup after confirmed window closure.
- Optional local Metamon is limited to Apple Silicon on macOS 14+. Cloud bots work on either architecture when the service is operational. Local Foul Play requires a working C compiler for its Rust/Python extension; a clean Mac may need Apple's Command Line Tools.
- The manual-only workflow pins one fetched main SHA, rejects a release version different from main's package.json, verifies source remains unchanged and records final artifact hashes. Every package uses `--publish never`; artifacts remain for private review.

## Credentials the owner must supply securely

Do not paste certificates, passwords or private keys into chat or commit them to Git.

**Signing:** an active Apple Developer Program membership and a **Developer ID Application** certificate with its private key. An Apple Development, Apple Distribution or Developer ID Installer certificate is not a substitute for this app/DMG route. On a signing Mac, import it into an unlocked keychain accessible to `codesign`. For the prepared GitHub Actions path, add these repository secrets:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | Base64 of the exported Developer ID Application `.p12`, including its private key. Electron-builder reads it as `CSC_LINK`. |
| `MAC_CERTIFICATE_PASSWORD` | Password protecting that `.p12`; mapped to `CSC_KEY_PASSWORD`. |
| `APPLE_ID` | Apple account used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password generated for that Apple account, not the normal account password. |
| `APPLE_TEAM_ID` | The Developer Program team's identifier associated with that account. |

The prepared workflow uses the Apple ID route above. On your own signing Mac, choose **one** supported notarization route:

1. The three `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` environment variables.
2. `APPLE_API_KEY` pointing to a local App Store Connect API `.p8` file, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Use a team API key authorized for notarization. This replaces the Apple ID route, but not the signing certificate.
3. `APPLE_KEYCHAIN_PROFILE` naming credentials previously stored with `xcrun notarytool store-credentials`, optionally `APPLE_KEYCHAIN` for a specific keychain.

Do not leave incomplete variables from another route set. The preflight intentionally rejects partial credentials instead of silently selecting a fallback. An installed Developer ID certificate alone cannot authenticate notarization; notarization credentials alone cannot sign the app. Apple account agreements, membership status and certificate validity must also be current.

## Build after approval to integrate into main

Until the owner approves integration, leave the audit branch available for review. The workflow checks out main, so dispatching it before integration cannot produce an audit-branch release. In particular, main currently lacks the new release preflight and will fail instead of packaging this feature source.

After approval and integration:

1. Fetch main and record its exact commit. Confirm `package.json` is 1.0.0 and the checkout is clean.
2. Use the **Release candidate builds** workflow, choosing `macos` (both architectures) or `all`, version 1.0.0. This uploads only private Actions review artifacts. No run was dispatched during the audit fixes.
3. Alternatively, on a prepared Mac at that exact clean main commit, run `npm ci`, `npm run check`, `npm run build:showdex`, `npm run build:practice`, and the unit tests, then `npm run pack:mac -- --arm64` or `--x64` with the credentials set. Use a clean output directory for each candidate. Prefer each architecture's native runner for validation.
4. Keep Apple's Accepted submission receipts/logs, `mac*-signature.txt`, the exact main SHA, and hashes of final **post-stapling** files with the private build records. Inspect warnings in Apple's log, not only the final status.
5. Review the exact release title, body and asset list with the owner before any public upload. Building/notarizing does not authorize publication.

## Exact Mac acceptance still required

Windows unit/integration results do not establish any of these native outcomes. Check the final signed artifact on **each advertised architecture**, the minimum macOS 13 version, and a current macOS version. Metamon has its separate macOS 14 minimum.

| Test | Passing evidence to retain |
| --- | --- |
| Signature and nested helpers | `codesign --verify --deep --strict --verbose=2` succeeds; displayed authority is Developer ID Application; timestamp and hardened-runtime flag present. Inspect entitlements on the app and helpers; no debugger or broad library-validation exception. |
| Apple notarization | Accepted result and reviewed notary log; `xcrun stapler validate` succeeds for app and DMG. |
| Gatekeeper/quarantine | Download the candidate through a browser on a clean Mac, retain quarantine, open DMG, drag to Applications and launch without bypassing Gatekeeper. App and DMG `spctl` assessments succeed. Repeat launch offline with a stapled ticket. |
| Fresh launch | Home/onboarding, both themes, narrow window, display scaling/fullscreen, sound and permission-denied notifications. No developer tools needed for normal app launch. |
| Upgrade | Replace an older release while preserving the stable profile: login, teams, notes, preferences and Daily progress. Old optional bot runtimes require Update; old Showdex assets fail verification and can be refreshed from Settings > Install Showdex. |
| Native input | App/Edit/Window menus; Command-C/V/X/A/Z, redo, hide, minimize, fullscreen, Command-W tab close, Command-number, Control-Tab and system Command-Tab. Check text fields inside Showdown and login popups, not just launcher inputs. |
| Quit/window lifecycle | Accept and decline close/quit prompts during a battle, with an unsaved note and during a bot download. Confirm cancellation stops the download/workers; no stranded Python/simulator process. Close last window, reopen from Dock, and quit/relaunch. |
| Files and account | Team import/export, replay-note export/import, file dialogs, clipboard, login/Google popup, password/registration/logout and account preference synchronization using an authorized test account. |
| Local practice | Complete and rematch a Foul Play game after a fresh optional install. Exercise the compiler prerequisite. On Apple Silicon/macOS 14+, install Metamon and complete/rematch an OU game. Intel and macOS 13 must explain unavailable local Metamon. |
| Showdex | Fresh installation and upgrade from old payload; actual damage values, preset loading, move/switch/Tera, both themes and narrow dock. |
| Network/lifecycle | Offline startup, lost connection, sleep/wake, reconnect and repeated tab/window operations; check CPU/memory and battery during an extended session. |
| Accessibility | VoiceOver names/order, keyboard-only navigation, focus visibility, large text/zoom and increased contrast/reduced motion. Automated Windows accessibility checks are not VoiceOver testing. |

Useful commands, using the exact final app and DMG paths:

```sh
codesign --verify --deep --strict --verbose=2 "Pokemon Showdown Evolved.app"
codesign --display --verbose=4 "Pokemon Showdown Evolved.app"
codesign --display --entitlements :- "Pokemon Showdown Evolved.app"
spctl --assess --type execute --verbose=4 "Pokemon Showdown Evolved.app"
xcrun stapler validate "Pokemon Showdown Evolved.app"
xcrun stapler validate "candidate.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "candidate.dmg"
```

## Remaining owner facts beyond Apple credentials

The cloud outage is understood and intentionally excluded from this repair task. No cloud host access, deployment or endpoint change was attempted. Restore/verify it operationally when appropriate.

The new privacy notice explains observed data flows and deletion controls. A private privacy contact and the cloud operator's retention/deletion arrangements still need owner-supplied facts before public marketing. Rights to branding/artwork also remain an owner/legal determination. Code changes cannot manufacture those facts or permissions.

Sources: [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Developer ID](https://developer.apple.com/developer-id/), [Electron macOS minimum](https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-12-support), [Electron 45.5.0](https://releases.electronjs.org/release/v45.5.0). Build hooks were also checked against the installed electron-builder 26.18.0 source.
