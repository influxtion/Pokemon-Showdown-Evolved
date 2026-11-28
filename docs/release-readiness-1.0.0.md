# 1.0.0 audit corrections and launch readiness

November 27, 2026. Work is isolated on `fix/final-release-audit`, based on main `5e0ac47703535304e9e0ce637c7f6f1bf8497f39`. The owner selected **1.0.0**, authorized audit corrections and explicitly prohibited merging or publishing. No release build, signing operation, Apple upload, workflow dispatch, host deployment or publication occurred.

**Status:** Source corrections are verified on the Windows development host. Release readiness still depends on an approved main integration, exact signed Mac artifact validation and Windows installer acceptance. No known vulnerabilities were reported in the dependency inventories tested below. This is not a guarantee that no vulnerabilities exist in the app, native runtimes, dependencies or remote services.

The target remains **direct Mac download, Developer ID signing and notarization**. It is not a Mac App Store/App Review submission. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) is distinct from functional review.

## Disposition of the original audit

| Finding | Correction / remaining requirement |
| --- | --- |
| R1: Mac signing disabled | Removed ad-hoc identity and disabled protections. Enabled hardened runtime, required signing/notarization, app/helper JIT entitlement and signed DMGs. Added strict credential/config preflight plus final ticket, signature, timestamp and Gatekeeper checks. Apple credentials and actual Mac signing execution remain required. |
| R2: No native Mac acceptance | Exact credentials and architecture/OS acceptance steps are in [mac-release.md](mac-release.md). Windows cannot supply this evidence. |
| R3: Workflow can build feature source | Workflow is manual only, checks out fetched main, pins one SHA for all payloads/platforms, verifies clean source and matching version, and retains provenance/hashes. No publish permission or publish step. Audit changes must first be approved for main. |
| R4: Cloud unreachable | Owner confirmed the cloud is down and asked not to address it. No endpoint or host changes; deliberately excluded from repair work. |
| R5: Metamon advisories | Updated CPU Torch to 2.15.0, setuptools to 84.2.1, wheel to 0.48.0, SymPy to 1.13.3, retaining official artifact hashes. Added `pip check` before promoting an install. Fresh installation/model loading, dependency consistency and two final OU games passed. Existing stale runtimes are blocked until explicitly updated. |
| R6: Showdex advisories | Patched upstream package/lock inputs to lodash/lodash-es 4.18.1, uuid 13.0.1, qs 6.16.1, ua-parser-js 2.0.10 and i18next 26.3.4. Rebuilt bundle, corresponding source archive and tracked manifest; repeated normal build reproduced the runtime hashes. Production audit now reports zero vulnerabilities. No hash-verification bypass. |
| R7: Electron behind | Updated exact npm/lock pin and downloaded runtime to Electron 45.5.0. Full Windows desktop and live suites exercised that runtime. |
| R8: Mac menus/shortcuts/lifecycle | Added native App/Edit/Window menu roles, Command tab actions and Control-Tab cycling. Confirmed last-window closure now cancels both optional downloads and closes private engines even if the app stays running. Unit and controlled desktop regression checks pass; native Mac behavior still needs acceptance. |
| R9: Stale metadata | Owner-selected 1.0.0 in package/lock, removed stale hidden 0.2.0 labels, corrected Windows Installer filenames and README's published-download link. README clearly distinguishes unpublished 1.0.0 and planned Mac support. |
| R10: Privacy disclosure gap | Added packaged `PRIVACY.md`, Settings summary/links and accurate reset-retention wording. Owner must still supply a private privacy contact and cloud retention/deletion facts before public marketing. |
| R11: Branding rights | No rights grant can be created by code changes. Owner/legal confirmation remains required; notarization does not determine these rights. |
| R12: Bot portability/supply chain | Hash-pinned Foul Play Python packages, Maturin and engine source; Cargo `--locked`; no unpinned pip build isolation. Fresh Windows install and real battles passed. Local Metamon explicitly requires Apple Silicon/macOS 14; app requires macOS 13. Fresh Mac native compiler/runtime checks remain. Mutable upstream data URLs remain hash-checked and correctly fail if content changes. |

Additional security hardening: download header and streamed sizes are bounded (model's pinned size or 1 GiB), stalled transfers time out after 15 minutes, and incomplete files are removed. Credential file types are ignored by Git. Windows executable signing is enabled when credentials are supplied; absence of a Windows certificate is explicitly reported as an unsigned private review candidate.

Existing Showdex users must use Settings > Install Showdex to refresh an old payload. Old assets do not match the new manifest and cannot be served. Native Showdex preferences are retained; installation replaces the assets atomically and retains the previous copy for recovery.

## Web research and application-specific security checks

The extra review used primary sources, rather than treating working UI as proof of security:

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security): remote Node/preload exposure, sandbox/context isolation, permissions, navigation/popups, IPC sender validation, external protocols, current runtime and fuses.
- [OWASP Top 10:2025](https://top10.owasp.org/): access control, insecure configuration, supply chain, cryptography, injection, authentication, integrity, logging and failure handling.
- [Wiz's Base44 investigation](https://www.wiz.io/blog/critical-vulnerability-base44): an example of authentication bypass through exposed endpoints. The transferable concern is server-side authorization, not trusting public application IDs or frontend controls.
- [Veracode's AI-generated-code research](https://www.veracode.com/blog/genai-code-security-report/): working generated code can still contain injection and other security faults. Its results do not provide an exploit rate for this app.
- [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): destination validation and redirect handling.

| Risk reviewed | Evidence in this app |
| --- | --- |
| Privileged renderer access / IPC bypass | Remote client has no Node/preload; sandbox/context isolation enabled. Main-frame, webContents and exact launcher-file checks gate privileged IPC. Real controlled remote/untrusted-window tests reject access. |
| Script/command injection | Launcher variable content uses DOM text or validated values; inspected `innerHTML` sites construct fixed markup. Bridge arguments are serialized and actions allowlisted. Python/native processes use executable plus argument arrays, not a shell command constructed from user text. No application SQL database/query builder is present. |
| Unsafe external navigation | Remote navigation/OAuth popups are contained; unsafe file/javascript/shell schemes cannot launch externally. Replay URLs/routes are constrained to the official host. Launcher CSP blocks arbitrary network/script/frame injection. |
| Local API abuse / session access | Local inference binds loopback and uses a generated 256-bit key; comparison is timing-safe. Session/queue identifiers are random capabilities, not public app IDs. WebSocket Origin is rejected; payload, rate, lifetime, queue and resource bounds are enforced. Official Showdown authentication is upstream, not reimplemented here. |
| SSRF / transport | Cloud origin is a fixed configuration, not arbitrary renderer input; HTTPS is required outside loopback. Inference fetch/socket redirects are refused. Pinned bot downloads can follow CDN redirects but are checked by content hash before use. No claim is made about an inaccessible deployed host. |
| Exposed credentials / logs | Selected credential patterns found no matches in tracked text or available local Git history. Secrets are referenced by workflow variable names, not stored in source. Worker environment is allowlisted. App logs accept fixed event names/numeric codes and rotate. This is not exhaustive entropy scanning. |
| Dependency / artifact integrity | Exact Electron pin, npm/pnpm locks, updated audited bot dependencies, pinned payload/source hashes, atomic runtime promotion/rollback, stale-runtime rejection and main-only provenance. |
| Malicious/oversized input | Import read bounds, URL/team/message validation, network response/frame caps, download caps and cancellation/backpressure/error tests. |

Residual scope: launcher pages still use tightly allowlisted `file://` URLs; Electron prefers a custom protocol as further hardening, but no exploit of this configuration was established. The embedded upstream client/ads, source-only Python packages, native Python/Rust libraries and all possible dependency paths are not exhaustively certified. The app uses inference bots, not a generative agent with tools; generic LLM prompt-injection findings should not be claimed as demonstrated app flaws.

## Verification on the final source

Evidence is retained locally under ignored `out/audit-fixes/`.

| Check | Result |
| --- | --- |
| Syntax and unit/API tests | Passed; **306 tests, zero failures/skips**, staged simulator enabled (`syntax-final.log`, `unit-final.log`). |
| Windows desktop | All **15** suites passed: 14 existing suites in `desktop.log`, plus the new accepted/declined download-close regression in `live.log`. Test-only painted-window/capture retry helper retained. |
| Live guest/UI integration | Startup, shell, Profile, teambuilder, Showdex install, Showdex dock, replay, app appearance and real practice/Showdex passed (`live.log`, `live-remaining.log`, `shell-retry.log`). |
| Live-shell transient | Initial immediate Community-session assertion saw missing menu state during a transition. The unchanged suite passed on retry. Original failure retained; this does not establish that every timing race is eliminated. |
| Fresh optional installs | Both Foul Play and Metamon installers completed; both `pip check` results clean. Initial Maturin executable-path failure was fixed and the fresh Foul Play install repeated. Initial SymPy mismatch was fixed and Metamon installation repeated. |
| Complete battles | Two final Medium Random battles, two Casual OU battles and two Metamon OU battles passed. Respectively 31/36/33 decisions, median 94/47/47 ms on this PC; not performance guarantees. |
| JavaScript advisories | Root, API, staged simulator and Showdex production audit: **zero known vulnerabilities**. |
| Python advisories | Fresh Foul Play and Metamon version inventories: **zero known vulnerabilities**. Torch's `+cpu` local suffix was normalized to 2.15.0 for explicit advisory lookup so it was not silently skipped. Source-URL `amago` and `poke-env` are excluded from version-based audit coverage and remain hash-pinned source dependencies. |
| Rust advisories | OSV queries for all **55 registry packages** in the pinned engine's Cargo.lock returned no advisories (`rust-osv-verified.json`). This is advisory coverage, not a native-code safety proof. |
| Payload/release configuration | Practice source manifest verification passed. Repeated Showdex build matched all 57 runtime hashes. electron-builder schema and workflow YAML parsed; preflight tests reject wrong source/version, missing credentials and disabled Mac protections. No native Mac hook execution was possible. |
| Accessibility | Zero selected automated WCAG A/AA violations across six pages in both themes. Manual/incomplete contrast and VoiceOver checks remain. |
| Visual sample | Inspected current Settings light and narrow dark/bottom captures; no clipping in the added privacy/reset content. Existing suite geometry assertions cover additional views. |
| Secrets | Selected patterns found no matches in tracked source or available local Git history; no credentials were requested or read. |
| Startup sample | Home 279 ms, connected 2,450 ms; page changes 23–83 ms in one guest Windows sample. |

## What still needs the owner or another environment

**Apple credentials:** Developer ID Application certificate/private key plus notarization authentication. [mac-release.md](mac-release.md) gives the exact GitHub secret names and three supported local authentication routes. Do not paste keys/passwords into chat. No Apple credentials have been accessed.

**Mac testing:** Build the approved main source, sign/notarize/staple it and test the final quarantined artifact on each advertised architecture and OS version. Include native menus/Command editing, notifications, login, file dialogs, quit/reopen, upgrades/profile retention, VoiceOver, sleep/reconnect, Showdex and fresh optional local bot installation/full battles. Only the Mac can establish hardened-runtime/JIT/helper/native-library compatibility.

**Windows launch:** Current source passes development-host acceptance. After main approval, produce the exact 1.0.0 installer and validate a clean standard-user Windows installation, upgrading an installed 0.4.0 profile, uninstall/reinstall, shortcuts, notifications, file dialogs and bot downloads. Verify installer/executable Authenticode signatures if signed. Apple credentials cannot sign Windows binaries. The prepared optional secrets are `WINDOWS_CERTIFICATE_P12_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`; hardware-backed/managed signing would need its own provider configuration. No Windows certificate was inspected, and an unsigned build must not be described as signed or guaranteed warning-free.

**Owner facts:** Private privacy contact, cloud retention/deletion arrangements, branding/artwork rights and accurate marketing/support claims. The cloud outage itself remains outside this task at the owner's request.

**Release approvals:** Review this branch, explicitly approve integration into main, then approve the exact public release copy and files before upload/publication. No part of the audit changed those standing approval requirements.
