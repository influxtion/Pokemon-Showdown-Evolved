# Final release audit: November 27, 2026

**Decision: do not distribute the current Mac candidate as a verified Developer ID release.** The Windows development app passes broad functional checks, but the repository is not configured to produce the requested signed, hardened, notarized Mac release. No Mac release artifact was produced or certified during this audit.

The owner clarified that the target is **direct Mac downloads with Developer ID signing and notarization**, not the Mac App Store. App Store sandboxing, store-only updates, store metadata, and App Review acceptance are therefore not requirements for this release. Apple's notarization is an automated security/signature assessment, not App Review or approval of functionality or intellectual-property rights. [Apple notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Scope and source

- Fetched `origin`; starting main and origin/main: `5e0ac47703535304e9e0ce637c7f6f1bf8497f39`.
- Work isolated on `fix/final-release-audit`. Only the accessibility corrections described below change application behavior. No feature branch was integrated.
- Host: Windows; Node 24.15.0, Electron 45.3.4, electron-builder 26.18.0. These tests are not macOS tests.
- Reviewed release/build configuration, app lifecycle, privileged IPC, remote views, navigation, OAuth popup guards, external links, local storage, replay handling, practice processes, cloud protocol, optional installers, Showdex payload, dependency inventories, privacy/network behavior, accessibility, and current test coverage.
- No owner account login, real PM/challenge, public ladder battle, host administration, certificate access, notarization upload, installer build, release upload, publication, or main merge occurred.
- Raw evidence is under ignored `out/final-release-audit/`. Existing suites also write screenshots to their documented `out/` directories. The report distinguishes current evidence from earlier project history.

## Release findings, ordered by urgency

### R1. Mac output is explicitly unsuitable for the requested signing route

**Confirmed blocker.** `electron-builder.yml:84` selects `identity: '-'`, followed by `hardenedRuntime: false` and `notarize: false`. The workflow also sets `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`. Current targets are DMG and ZIP, which are appropriate container types for direct distribution, but these settings do not produce a Developer ID notarized app.

Configure a real Developer ID Application identity, hardened runtime and the minimum required entitlements, secure timestamping, and notarization credentials through a secure build environment. Verify nested helpers and any distributed executables, inspect the notarization log, staple the ticket, and assess the final artifact with Gatekeeper. Do not merely remove `notarize: false` and assume an unsigned build has become safe. Apple explicitly distinguishes Developer ID certificates from ad-hoc identities and requires signing protections for modern notarized software. [Apple preparation requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

**Evidence:** `release-config.json`; `electron-builder.yml`; `.github/workflows/native-release.yml`. No certificate/private key was requested or read.

### R2. No current signed Mac artifact has passed native acceptance tests

**Release evidence blocker.** This Windows host cannot establish that either Apple Silicon or Intel builds launch under hardened runtime, survive quarantine/Gatekeeper checks, start the simulator child, or run downloaded native Python/Rust/Torch code. Earlier unsigned Mac CI builds are not evidence for this configuration or this source tree.

Test the exact release artifact on each advertised architecture and the minimum advertised macOS version as well as a current macOS version. At minimum cover fresh download/install, launch from Applications, login persistence, team import/export, file dialogs, clipboard, sound, notification clicks, quit/reopen, sleep/reconnect, Showdex, and a complete practice battle. Exercise the optional local bot installer separately; it downloads executable code outside the app bundle. Do not claim that notarizing the outer app proves that those later downloads work.

### R3. Main's release workflow still permits feature-branch application sources

**Confirmed release-control defect.** `.github/workflows/native-release.yml` uses checkout without a pinned main ref in both jobs, accepts workflow dispatch on a selected ref, and retains an obsolete automatic trigger for `feat/automatic-updates`. It does not implement the owner's main-only rule. The previously prepared correction exists on `fix/main-release-builds`; its presence there does not change main's workflow.

Before any release build, fetch main, resolve one SHA, use that same application-source SHA for every payload and platform, verify tracked source remains unchanged, and record it in the artifact receipt. Keep a workflow carrier branch distinct from application source. Integrating corrections into main still requires owner approval.

### R4. The configured cloud bot service was unreachable during this audit

**Confirmed observation; external cause unknown.** `https://34-174-209-142.sslip.io/healthz` and `/v1/info` failed from this machine. A Node retry reported `UND_ERR_CONNECT_TIMEOUT`; an independent curl request also timed out. DNS resolved to `34.174.209.142`. Showdown, replay hosting, and the GitHub release redirect returned HTTP 200.

This prevents verifying the default cloud bot path and Daily challenge against production. It does not prove a worldwide outage, a TLS defect, or a particular host misconfiguration. The app defaults to cloud; local engine successes do not clear this release concern. The host owner must establish reachability, current deployed source, capacity, and successful real bot games. Do not use the owner's Google accounts to access the friend's host.

**Evidence:** `service-health.json`, `cloud-retry.log`, `cloud-curl.log`. No deployment was attempted.

### R5. Optional Metamon dependencies have unresolved vulnerability reports

**Confirmed dependency finding; no exploit demonstrated.** Tracked pins include `setuptools==78.1.0` in both bootstrap and runtime requirements, `wheel==0.45.1`, and Torch 2.6.0. Auditing the installed environment initially skipped URL-installed Torch. A second audit explicitly included its pinned version, avoiding a false clean result.

- The version audit returned 31 advisory entries across three packages, including duplicate aliases. Deduplication produced 26 advisory groups: setuptools 3, wheel 1, Torch 22. These are scanner findings, not 26 demonstrated attack paths.
- Setuptools findings include `CVE-2025-47273`; the current complete set points to fixes through 84.1.0. Wheel's `CVE-2026-24049` is fixed in 0.46.2. [Setuptools advisory](https://github.com/pypa/setuptools/security/advisories/GHSA-5rjg-fvgr-3xxf), [wheel advisory](https://github.com/pypa/wheel/security/advisories/GHSA-8rrh-rw8j-w5fx).
- Torch includes `CVE-2026-24747` affecting the weights-only unpickler. The worker uses `torch.load(..., weights_only=True)`, so that flag alone is not a complete mitigation for this version. The upstream advisory identifies 2.10.0 as the fix for this particular issue. [PyTorch advisory](https://github.com/pytorch/pytorch/security/advisories/GHSA-63cw-57p8-fm3p).
- Mitigations: the model and download archives are hash-pinned; users cannot choose an arbitrary model through the app UI; CPU inference uses a fixed model; Dynamo is disabled; Hugging Face is configured offline; W&B is disabled. Many tensor/JIT/compiler advisories may not be reachable through this worker. Reachability was not exhaustively proven.
- `amago` and `poke-env` are source-URL installs and remain outside ordinary version-based pip-audit coverage. The installed Windows environment is not an inventory of a freshly installed Mac runtime.

Update and hash-pin compatible dependencies, rebuild the supported runtimes and rerun model loading and complete games. If a dependency cannot be updated, document a specific reachability assessment or disable that optional path for the release. Do not blindly replace Torch on release day without testing model compatibility. Changing the installer pins also needs a strategy for existing optional installs; `LocalEngine.target()` allows an installed runtime even when its `current` flag is false.

**Evidence:** `python-audit-metamon.json`, `python-audit-metamon-versions.json`, `python-advisories-deduplicated.json`; `api/metamon/bootstrap.txt`, `requirements.txt`, `lock.json`, `worker.py:77`.

### R6. The pinned Showdex source dependency tree is not audit-clean

**Confirmed dependency finding; shipped-code reachability unresolved.** Production pnpm audit reports 11 entries: 2 high and 9 moderate. Affected package names are lodash, lodash-es, uuid, qs, ua-parser-js and i18next. The high entries concern lodash template code injection; they are the same advisory on two package variants. The current upstream advisory recommends 4.18.1, which is more specific than the scanner's older 4.18.0 range. [Lodash advisory](https://github.com/lodash/lodash/security/advisories/GHSA-r5fr-rjxr-66jc).

The audited checkout is the pinned Showdex commit. Its package.json and pnpm lockfile match the corresponding files inside the verified bundled source archive. This establishes that the findings are about the actual build inputs, rather than an unrelated checkout. Tree shaking can exclude vulnerable functions, so a lockfile finding alone does not establish exploitable bundled JavaScript.

Initial reachability checks found uuid v5 called without an output buffer and qs.stringify called without the vulnerable comma-format options at inspected call sites. No app exploit was demonstrated. Complete bundled-code analysis or update the reviewed Showdex dependency pins, rebuild the bundle and source archive, regenerate the reviewed manifest, and rerun calculator/preset/dock tests. Do not edit the generated bundle or bypass the manifest verifier.

**Evidence:** `showdex-audit.json`, `showdex-advisory-summary.json`; `vendor/showdex/SOURCE.md`. The source's expected `.env` and readiness patch were already present; this audit did not modify them.

### R7. Electron is behind the current stable release

**Maintenance finding.** The app pins 45.3.4; the registry and official release page report 45.5.0 as latest stable, released November 24. That release updates Chromium and fixes renderer crashes and system contrast handling. Root npm audit returning zero does not establish that the embedded Chromium runtime has no security exposure. [Electron 45.5.0 release notes](https://releases.electronjs.org/release/v45.5.0).

Review intervening Electron/Chromium fixes and update the pin before final signing, then rerun platform tests. No Electron upgrade was silently included in this audit branch; its test results remain attributable to 45.3.4.

### R8. Mac menu and keyboard behavior need native correction/verification

**Confirmed source behavior; Mac impact not exercised.** `app/main.js:1063` removes the application menu on every platform. `app/shortcuts.js` requires Control and rejects Meta, so Command-W and Command-number do not invoke the app's tab actions. This warrants native App/Edit/Window menu roles and Mac keyboard behavior, especially copy/paste, undo, select-all, hide, quit and window reopening. Electron documents the application menu and its native roles. [Electron Menu API](https://www.electronjs.org/docs/latest/api/menu).

Windows Ctrl-based navigation tests do not validate macOS menu accelerators. Do not mark this resolved without a Mac run. Also test cancellation of an optional download when closing the last Mac window: the engine disposal hook is on `will-quit`, while macOS deliberately keeps the application running after all windows close.

### R9. Version, filenames, and public download documentation are stale

**Confirmed.** `package.json` and the lockfile still use 0.2.0; README points users to v0.2.0 and older Mac downloads, while the current public latest redirect is v0.4.0. The current main NSIS artifact template still says `Setup`, contradicting the owner's installer naming rule. Static rail markup contains `v0.2.0-dev` (even where CSS hides it).

Choose the intended new release version explicitly, keep artifact metadata and filenames consistent, update download instructions for the actual supported Mac architecture(s), and ensure Settings reports the packaged version. No new version number, tag, or release text was invented here. Publication still requires approval of exact copy and files.

### R10. Privacy documentation must cover embedded third-party traffic

**Confirmed observation and documentation gap, not an App Store gate.** A disposable guest profile with Showdex disabled made requests to 61 distinct HTTP(S)/WebSocket origins in the final observation window. These included Showdown and advertising/identity infrastructure such as DoubleClick, Criteo, ID5, Eyeota and Taboola. The official remote client is embedded and loaded at startup; the launcher's restrictive CSP does not suppress all network activity in that separate client session.

Only origin/count pairs were saved, not full URLs, cookies, account credentials or message bodies. The observed count is a time-limited sample; it is not a permanent endpoint inventory. Do not advertise the entire app as tracking-free based on the absence of a first-party analytics SDK.

No app-specific privacy policy was found in the tracked UI/docs. Document the service operators and actual data flows, retention/deletion, optional cloud bot traffic, updater requests, Showdex requests and local storage. Do not invent the friend's server retention policy. Showdex's Teledex code inspected here writes bounded local diagnostics to IndexedDB and offers file/clipboard dumps; its name alone is not proof of remote telemetry. Bakedex is a separate preset catalog service.

**Evidence:** `network-origins.json`, `accessibility-network.cjs`, `app/practice-engines.js`, `api/client.js`, Showdex source.

### R11. Branding and distribution rights are not established by this audit

**Owner/legal evidence needed.** README acknowledges that Pokémon names and artwork are owned by third parties. This repository contains software licenses and attribution, but no reviewed rights grant covering every brand/artwork/service use. AGPL/MIT/GPL source licensing does not itself establish rights to Pokémon branding or third-party art. Direct distribution removes the App Store review question, not the underlying rights question. Confirm rights and license obligations with the relevant owners or qualified counsel; notarization is not a substitute.

Bundled Showdex and practice source/license records passed the existing packaging checks. This is evidence of retained notices/source, not a legal opinion that every distribution obligation is satisfied.

### R12. Local bot portability and supply-chain limitations remain

- Foul Play's Mac installer can require a C compiler and tells users to run `xcode-select --install`; fresh non-developer Mac installation is untested.
- Metamon has a darwin-arm64 Torch wheel, but no darwin-x64 wheel in its current support map. Intel local Metamon must stay unavailable unless support is separately implemented and verified.
- Foul Play pins package versions but does not hash every pip artifact or transitive Rust build input. Its Python/source/data downloads are hash-checked; these are different levels of reproducibility.
- Six live Foul Play data downloads returned 200 and matched the current pins. Several URLs remain mutable upstream; a future change can correctly fail a fresh install with a checksum mismatch. Never solve this by skipping verification.
- The preexisting local Foul Play runtime used in this audit reported installed=true/current=false. Its nine installed Python packages audited clean and real games passed, but this is not a fresh installer proof.

**Evidence:** `download-data-hashes.json`, `python-audit-foulplay.json`, `api/install.js`, `api/lock.json`, `api/metamon/lock.json`.

## Corrections implemented on the audit branch

Fixed three classes of reproducible accessibility defects:

1. Branding containers now have an image role, making their existing accessible labels valid.
2. The account/Profile button's accessible name includes the visible account name and Profile label.
3. Small Home header links and bot-status text use full text contrast on tinted surfaces. Initial measured ratios included 4.19:1 and 4.46:1 for the Home link and 3.91:1 for bot status, below the relevant 4.5:1 threshold.

Changes are limited to eight launcher HTML files, `renderer/nav.js`, and `renderer/app-appearance.css`. Axe-core 4.14.1 now reports zero violations for the selected WCAG A/AA rules across Home, Bots, Replays, Stats, Resources and Settings in light/dark themes. Automated results do not establish VoiceOver usability, all custom palette combinations, or full accessibility compliance. Incomplete/manual checks remain in the JSON output.

## Verification results

| Check | Result and limits |
| --- | --- |
| Syntax | Passed before and after accessibility corrections. |
| Unit/API/Python-wrapper tests | Final run: 297 passed, zero failed, zero skipped; optional real staged-server test enabled. |
| Desktop suites | All 14 passed on the final source across `final-desktop.log` and the navigation retry in `final-targeted.log`. |
| Live guest suites | Startup, shell, Profile, teambuilder, Showdex install, Showdex dock, replay review, appearance, practice with Showdex all passed on the audited baseline. Profile and startup were repeated after the accessibility corrections and passed. |
| Transient failures | Friends and teambuilder initially hit `UnknownVizError`; passed with the existing test-only capture-retry helper. Dock initially timed out waiting for visibility and passed on rerun. The final navigation suite encountered load cancellation (-3), then passed on retry. Underlying timing causes are not proven. No assertions were removed. |
| Real Foul Play games | Two Medium Random Battles and two Casual OU games completed through a loopback API; 37 and 52 decisions, medians 109 ms and 31 ms respectively. These are this machine's integration samples, not strength/latency guarantees. |
| Practice desktop | Real move/switch/Tera, view retention, themes/sizes, Stop, Forfeit, rematch, crash/hidden-disconnect cleanup and tab close passed. Expected CSP denials for optional Showdex requests were retained. |
| Package source checks | Verified the simulator manifest, current adapter/client/dependency sources and pinned Showdex payload/source materials. No installer or signed artifact was built. |
| JavaScript advisories | Root, API and staged simulator npm audits: zero known vulnerabilities. Separate Showdex audit has findings above. |
| Python advisories | Installed Foul Play: zero known vulnerabilities in 9 packages. Metamon: findings/coverage exclusions above. |
| Secret pattern scan | 210 tracked files scanned for selected private-key and token patterns; no matches. Not a full history or entropy scan. |
| Accessibility | 12 page/theme combinations, zero automated violations after corrections; manual/incomplete checks remain. |
| Live data pins | All six fetched data resources matched their recorded SHA-256. |
| Startup samples | Baseline: Home 599 ms, connected 3,391 ms, page navigation 35-2,457 ms. Final: Home 734 ms, connected 2,723 ms, navigation 18-70 ms. Guest Windows development samples with live services, not performance guarantees. |
| Visual inspection | Inspected selected fresh Home, Bots, Profile, Stats and practice/Showdex captures, including narrow views. Suite assertions cover more combinations than the manually inspected sample. |

Security controls inspected and exercised include sandboxed remote views without Node/preload access, main-frame/sender IPC checks, URL and action allowlists, denied permissions, OAuth popup containment, bounded API replies/WebSocket messages, isolated practice/replay sessions, authenticated loopback simulator sockets, atomic storage and failed-write handling, replay URL validation and import conflict/undo handling, queued-practice cancellation, and update restart guards. Passing these checks is not proof against every possible exploit.

## Data and privacy inventory for the release owner

| Data / connection | Observed design |
| --- | --- |
| Showdown account, teams, chat and preferences | Persistent `persist:showdown` session communicates with the official client/services. Signed-in lifecycle not tested. |
| Launcher settings/window state/replay notes/daily progress | Local profile files; replay URLs can include private replay tokens. Exports can contain sensitive notes/links. |
| Recent format activity | Launcher localStorage, keyed by account, with observed battle sequence/time; not historical server last-played data. Sign-out clears the Showdown partition, not all launcher-local history. |
| Diagnostic logs | App logger uses fixed event names and numeric codes, with rotation; no account text or replay URL arguments accepted. |
| Cloud bots | Selected bot/team setup and the bot-view battle protocol go to the configured inference service. Its operational logging/retention was not verified. |
| Optional local bots | Python/model/source downloads are placed in the profile; separate worker processes perform inference. No model is bundled into the desktop installer. |
| Showdex | Explicit optional installation from a verified inert payload; network preset/catalog requests and separate local preferences/diagnostics. Practice request allowlist is narrower than the online client. |
| Updates | Windows/AppImage use GitHub updater requests; Mac currently links to manual downloads. Automatic installation on quit is disabled. |
| Remote artwork/ads | Remote artwork and the embedded client contact external hosts; final observed origin list saved without query strings. |

## Required final Mac release acceptance

1. Resolve the code/dependency and production-service findings, review the resulting changes, and obtain owner approval before integrating into main.
2. Build from one freshly fetched, approved main SHA with the chosen release version. Produce only the intended architecture(s) and containers; retain source/hash receipts locally.
3. On the Mac signing environment, prove Developer ID signatures, timestamps, hardened-runtime flags, entitlements and nested helper signatures. Do not add broad entitlements without an identified requirement.
4. Submit the exact candidate for notarization, inspect the returned log, retain the Accepted receipt and staple the ticket. Verify the final post-stapling hashes, not only pre-signing files.
5. Validate the final `.app` and distribution container. Typical read-only checks on the Mac include:

   ```sh
   codesign --verify --deep --strict --verbose=2 "/path/Pokemon Showdown Evolved.app"
   codesign --display --verbose=4 "/path/Pokemon Showdown Evolved.app"
   codesign --display --entitlements :- "/path/Pokemon Showdown Evolved.app"
   spctl --assess --type execute --verbose=4 "/path/Pokemon Showdown Evolved.app"
   xcrun stapler validate "/path/Pokemon Showdown Evolved.app"
   xcrun stapler validate "/path/final.dmg"
   ```

6. Download the actual candidate through a browser on a clean Mac and test it with quarantine intact. Do not remove quarantine or disable Gatekeeper to obtain a passing result. Verify installing over the previous release preserves teams/login/preferences/notes, and that normal launch does not require developer tools. Test optional local bots explicitly or disclose their requirements.
7. Finish native acceptance: Command-key editing and tabs, menus, quit/reopen and cancelled quit, downloads/worker cleanup, file import/export, notices, sounds, VoiceOver/keyboard focus, display scaling, sleep/wake, offline/reconnect, a complete cloud/local practice game and Showdex. Authenticated actions require the owner's participation or an authorized test account.
8. Update accurate download/support/privacy instructions. Show the owner the exact release title, body and asset list before any public upload/publication, as required by AGENTS.md.

No same-day completion or Apple acceptance is guaranteed. This audit establishes what was tested and what still prevents a defensible release decision; it does not replace testing the signed Mac artifact.

## Evidence map

All paths below are relative to `out/final-release-audit/`:

- `final-syntax.log`, `final-unit.log`, `desktop.log`, `live.log`, `retry-and-accessibility.log`, `final-desktop.log`, `final-targeted.log`.
- `foulplay-random-live.log`, `foulplay-ou-live.log`, `staged-server.log`, `package-source.log`, `source-evidence.json`.
- `npm-audit-root.json`, `npm-audit-api.json`, `npm-audit-simulator.json`, `showdex-audit.json`, `showdex-advisory-summary.json`.
- `python-audit-foulplay.json`, `python-audit-metamon.json`, `python-audit-metamon-versions.json`, `python-advisories-deduplicated.json`.
- `accessibility-before.json`, `accessibility.json`, `network-origins.json`, `process-metrics.json`. Memory metrics are an exploratory sample during the audit, not a leak/battery certification.
- `service-health.json`, `cloud-retry.log`, `cloud-curl.log`, `download-data-hashes.json`, `secret-pattern-scan.json`, `release-config.json`, `electron-dist-tags.json`.

The small audit-only harness and axe dependency are under ignored output, not packaged application source. Original failures remain in the logs; successful retries do not erase them.
