# Privacy and data use

Updated November 27, 2026 for Pokemon Showdown Evolved 1.0.0.

Pokemon Showdown Evolved is an independent desktop client. It loads the official Pokemon Showdown website and connects to other services described below. This notice describes the app's code and observed behavior; each external service operates under its own policies.

## Data on your computer

The app saves settings, window position, replay notes and links, Daily challenge progress, and recently observed format activity in its local profile. The embedded Showdown client saves its login session, local teams, chat preferences, cache and other website storage. Showdex has separate local preferences and diagnostic records. Optional bots save downloaded code, Python runtimes and model/data files locally.

Replay links can contain private access tokens. Notes, team exports, logs and diagnostic dumps may contain information you do not want to share. Review files before sharing them. Launcher logs contain fixed event names and numeric error codes and are rotated. No separate launcher analytics or automatic crash-upload service is configured in this source; this does not mean the embedded websites are tracking-free.

## Connections and third parties

- **Pokemon Showdown:** The official client is loaded at startup, including when you remain on Home. Account actions, online teams/battles, chat and preferences communicate with Showdown. Google sign-in, when selected, opens Google's account flow. Showdown and its embedded advertising providers may receive IP addresses, browser/device information, cookies or other identifiers. Observed providers include Google/DoubleClick, Criteo, ID5, Eyeota and Taboola; this is not a fixed or exhaustive list. See [Showdown's privacy policy](https://pokemonshowdown.com/privacy).
- **Cloud bot practice:** Cloud is the default. Starting cloud practice sends the selected format, bot/team setup and the bot's view of the battle protocol to the configured inference service. It does not sign in to your Showdown account or upload a public replay. The service also receives connection information such as your IP address. The hosting operator's operational logging, retention and deletion arrangements have not yet been supplied to this project; do not interpret this notice as a no-logging promise. Local bot inference is an alternative after downloading a compatible runtime.
- **Local bots:** Downloads contact GitHub, Python/PyPI, PyTorch, Hugging Face, Rust, Smogon and bot-data hosts as applicable. These hosts receive ordinary download request information. Inference uses a private loopback connection and local worker processes. The rest of the app can still contact Showdown and other online services while you play locally.
- **Showdex:** Installing the bundled optional integration does not require downloading its bundle from an extension store. Once enabled, it requests remote presets/catalogs and artwork. Its inspected Teledex diagnostics are stored locally; exporting a dump is a separate action.
- **Replays and artwork:** Opening a replay or viewing remote images contacts their hosting services. Saving a replay note does not itself upload your note to a server.
- **App updates:** Update/download checks contact GitHub. Windows and supported Linux packages can download updates; macOS uses manual downloads. The app does not automatically restart to install an update.

## Retention and deletion

Local data remains until you remove it or use the relevant controls. Settings > Sign out clears the embedded Showdown session, including local teams and preferences, while keeping launcher notes. Settings > Reset launcher data clears launcher settings and replay notes; it does not remove the Showdown session, all website storage, Daily progress, or downloaded bots. Bots > Downloads > Remove removes that bot's local runtime/model. These controls do not delete data already held by external services.

To remove the entire local profile, export anything you want to keep, quit the app fully, and remove the `showdown-desktop` directory under:

- macOS: `~/Library/Application Support/`
- Windows: `%APPDATA%\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/`

A custom profile location set by a developer may differ. Removing the app alone does not necessarily remove its profile, exports, OS backups or remote account data. Requests concerning Showdown or another service must also be directed to that operator.

## Questions and release-owner follow-up

Project information is available at [Pokemon Showdown Evolved on GitHub](https://github.com/influxtion/Pokemon-Showdown-Evolved). Do not put credentials, private replay tokens or private account data in public issues. Before marketing 1.0.0, the release owner must provide a private privacy contact and confirm the cloud operator's retention/deletion arrangements. Those facts cannot be established from the desktop source alone.
