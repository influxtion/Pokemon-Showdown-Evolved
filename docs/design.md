# Pokemon Showdown Evolved: design

This document describes what Pokemon Showdown Evolved is, how it is built, and why. It is the single reference for the app. Everything about the practice bots lives in [bots.md](bots.md).
## Contents

1. [Summary](#1-summary)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [Feature details](#4-feature-details)
5. [Key decisions](#5-key-decisions)
6. [Security and privacy](#6-security-and-privacy)
7. [Testing](#7-testing)
8. [Build, packaging and release](#8-build-packaging-and-release)
9. [Status, risks and open questions](#9-status-risks-and-open-questions)
10. [Appendix: visual design](#10-appendix-visual-design)

## 1. Summary

Pokemon Showdown Evolved is a free, open-source Electron app for Windows that hosts the **unmodified** official Pokémon Showdown client and adds tools around it.

A browser tab gives Showdown no stable home for tools, and offers no safe way to practise against bots: automated play on the public server would use a real account and the public ladder. The app keeps the client and its tools in one window and keeps practice entirely off the public server.

**Audience.** Existing Showdown players, especially Showdex users, who want a dedicated, dependable app. The bar is a clean, reliable integration rather than a bundle of add-ons. There is no subscription, launcher account or paid AI API.

## 2. Features

### Overview
- Overhaul of the Showdown **UI** and **navigation**
- Pinned Showdex **damage calculator**
- **Replay notes**, with in-app replay review and backup/restore
- Planned: game **analysis** against an engine's expected best play (not implemented)
- **Practice** battles against **Foul Play**, a top ladder engine, and three simple offline bots

### Showdown client
- Official `play.pokemonshowdown.com` client in a persistent partition; sign-in survives restarts.
- Injected theme follows Appearance; type, HP and stat colors are never restyled.
- External links open in the system browser; only Google sign-in may open a popup.

### Showdown overhaul
- **Icon bar and room tabs:** a slim icon bar on the left for Home, Stats, Replay notes, Practice and Settings, with the account at the foot. Showdown rooms are tabs across the top, with close buttons and **Join a room**.
- **Battles persist** across page changes. A new battle takes focus; Home shows **Return to battle**; an ended battle offers **Save replay note**, **Close battle**, **Battle again**.
- **Home:** format and team pickers, **Battle**, **Cancel**, **Challenge a user**, the format's rating, win rate, record and GXE, plus news and editable chat room shortcuts. Two layouts, **Classic** and **Revamped**, chosen once in a first-launch welcome and switched in Settings.
- **Stats:** ladder totals and a sortable per-format table; **Play** preselects a format, never starts a search.
- **Restyled rooms:** Ladder, Teambuilder, Community, chat, battle and tournament rooms restyled by CSS only (`app/client-*.css`). All rules are scoped to `sd-launcher-shell`, so the stock client returns if the bridge stops.
- **Format picker:** the client's own picker shown as a centered modal.
- **Friends:** presence refreshed at most every 30 s.

### Showdex
- `npm run build:showdex` builds Showdex 1.4.2 at a pinned revision and verifies every asset against a SHA-256 manifest.
- Enabled in Settings, then an explicit client reload; a battle is never reloaded automatically. Failure leaves normal play intact.
- Packaged as an inert, verified payload with license and corresponding source; installed and enabled only on explicit opt-in.

### Replay notes
- **Notes:** a replay link plus title, format and notes. **Save replay note** on a battle prefills players and format; it never uploads.
- **Limits:** title 120 chars, notes 5,000, 1,000 notes / 8 MiB.
- **Search** over titles, formats and notes. **Ctrl+F** search, **Esc** clear, **Ctrl+S** save. Drafts survive navigation.
- **Review:** the official replay page opens beside the note, locked to that one replay. Showdown's player does all playback.
- **Backup:** **Export** to versioned JSON; **Import** previews new / unchanged / conflict notes (existing kept by default) and applies in one atomic write. **Undo import** works for the current session only.

### Analysis (planned, not implemented)
Reviews a finished game turn by turn and shows where the player's choices differed from an engine's.

- **Input:** a just-finished practice or online battle, or a saved replay note. The analysis reads the battle's protocol log, never a live battle.
- **Scope:** Gen 9 Random Battle only, the format the bots play.
- **Fair view:** each decision is judged only on what the player could see at that point. The engine fills in hidden information the same way the bots do (determinization), so it never uses the opponent's revealed team.
- **Per decision:** the engine's top choices with their search share, the player's actual choice, and a verdict:

| Verdict | Rule |
| --- | --- |
| Best | Player's choice is the engine's top pick |
| Good | Within 75% of the top pick's share |
| Inaccuracy | 25–75% of the top pick's share |
| Mistake | Under 25%, or not considered |

- **Summary:** agreement rate, a count of each verdict, and the biggest mistakes linked to their turns. Thresholds are starting values to tune.
- **Viewer:** the replay player beside a turn list. Selecting a turn jumps playback there and shows its verdict.
- **Engine:** Foul Play, through the practice API's planned analysis endpoint (below).
- **Results** are cached with the replay note so a game is analysed once.
- **Privacy:** only the battle log is sent to the practice API, with no account details. Analysing an online game never acts on the account.

### Practice API (`api/`)
- **One interface for inference.** The battle always runs on the player's computer, on its own simulator. Only the bot's moves come from the practice API (`api/server.js`): on the cloud server by default, or, for a player who opts in, a copy the app runs on 127.0.0.1. The bot is Foul Play at three levels (Hard, Medium, Casual); Hard also plays OU.
- **A queue for the cloud.** When every cloud engine is busy, starting a Foul Play battle puts the player in line instead of failing: first come, first served, up to 20 waiting, one place per network. The battle tab shows **Waiting for a cloud engine** with the place in line (no time estimate; battles vary too much), **Leave queue**, and, if Foul Play is downloaded, **Play on this computer instead**. The app checks in every 3 s and the battle starts by itself when it is the player's turn; a place lapses after 15 s without a check-in, so a closed app never blocks the line. The Bots cards say "Cloud server busy · N waiting. You'll wait in line". Protocol: [api/README.md](../api/README.md#the-queue).
- **Cloud by default, local as an opt-in.** Foul Play plays on the cloud server unless the player downloads it. The Bots page's **Foul Play on this computer** panel downloads it (about 140 MB; `api/install.js` into the app's user data folder, building the search engine on first install), shows progress with **Cancel**, then offers **Cloud server / This computer** (saved as `practiceEngine`) and **Remove**. Nothing Foul Play-related is downloaded unless the player asks. Locally, the app starts the same API server on 127.0.0.1 with a private key, searching with up to 8 threads (the CPU's count, if lower) at below-normal priority. Closing the app mid-download asks first. Tests run the same server on loopback as a stand-in for the cloud.
- **Not bundled.** Foul Play (GPL-3.0) is installed only on the server (`api/install.js`, hash-checked against `api/lock.json`) and never shipped in the app.
- **Limits.** Anonymous access with per-network rate limits, a server-wide session cap and a thread cap; an optional API key ([api/README.md](../api/README.md)).
- **Hosting.** The default cloud server is one Google Cloud VM at `https://34-174-209-142.sslip.io` (`CLOUD_API_URL`). The API runs as a systemd service on `127.0.0.1:8787` behind Caddy, which provides HTTPS; only ports 80 and 443 are open. It serves 8 battles at once with 2 search threads each, so **Full** runs with 2 threads in the cloud. Step-by-step hosting: [api/README.md](../api/README.md#host-it-on-a-server).
- **Analysis endpoint (planned):** `POST /v1/analyze` with the battle log up to a decision, the player's side and the engine; it returns ranked choices and search shares. It is stateless and needs no simulator session.
- Protocol, limits and deployment: [api/README.md](../api/README.md) and [bots.md](bots.md).

### Practice
- Gen 9 Random Battle and Gen 9 OU on a private simulator on the player's computer, never the public server. Opponents: **Foul Play** (Hard), **Foul Play Medium** and **Foul Play Casual** (Medium), all on the cloud server, and three simple bots that run in the app (Easy: **Heuristic**, **Greedy**, **Random**). OU is Foul Play (Hard) only, with both teams chosen by the player.
- The **Bots** page (under Teambuilder in the sidebar, also reachable from **Play against bots** in the Home battle panel) lists the bots as cards with a **Play** button each; the battle plays in its own **Bot battle** tab with Forfeit, **New battle** and **End practice**. Closing that tab ends practice. Status shows thinking, turn, time and result.
- Practice and online games stay loaded side by side; the online account is never used.

### Settings
- Appearance, Home layout, Battle screen (launcher style or Showdown's original; applies at once, even mid-battle), start page, close protection for battles and searches, client reload, open logs. Where Foul Play runs (cloud or this computer) is chosen on the Bots page.
- **Sign out** clears the Showdown partition, local teams included. **Reset launcher** clears settings and replay notes but keeps the session. Both confirm first.
- Window size, position and maximized state are remembered.

## 3. Architecture

One Electron 45 window (Node 24) hosts four kinds of web content with different trust. The main process owns all state, files, child processes and secrets.

```mermaid
flowchart LR
  subgraph Window["Electron window"]
    L["Launcher pages<br/>(trusted, preload)"]
    S["Showdown client view<br/>(remote, no preload)"]
    R["Replay review view<br/>(remote, no preload)"]
    P["Practice view<br/>(sandboxed, no preload)"]
  end
  M["Main process<br/>state · IPC · files · secrets"]
  L <-- "named IPC channels" --> M
  M -- "allowlisted bridge" --> S
  M --> R
  P -. "loopback WebSocket" .-> SIM["Practice simulator<br/>(child process)"]
  M -- "bridge plays the bot seat" --> SIM
  M -- "frames / choices (WebSocket)" --> API["Practice API<br/>cloud, or 127.0.0.1"]
  S -. "HTTPS" .-> PS["play.pokemonshowdown.com"]
  R -. "HTTPS" .-> RS["replay.pokemonshowdown.com"]
```

| Part | Where | Trust and isolation |
| --- | --- | --- |
| Main process (`app/main.js`) | Electron main | Windows, IPC, settings, replay storage, logs, practice lifecycle |
| Launcher pages (`renderer/*.html`) | `BrowserWindow` | `window.desktop` from `app/preload.js`; every call is a named, validated IPC channel |
| Showdown client | `WebContentsView`, partition `persist:showdown` | No preload, no Node; themed by injected CSS; popups only for Google sign-in |
| Showdown bridge (`app/showdown.js`) | Main, runs functions in the client page | Reads a sanitized snapshot; sends allowlisted actions |
| Replay review (`app/replay-review.js`) | `WebContentsView`, nonpersistent `replay-review` session | No preload, no Node; locked to the saved replay's path |
| Showdex (`app/showdex-integration.js`) | Custom scheme inside the client view | Optional, pinned, SHA-256-verified |
| Practice view (`app/practice-view.js`) | `WebContentsView` | Patched classic client; no preload, no Node; reaches only its session |
| Practice session (`app/practice-session.js`) | Main ↔ local simulator ↔ practice API | Runs the simulator, plays the bot's seat, relays only the bot's battle-room frames and validated choices ([bots.md](bots.md)) |
| Practice engines (`app/practice-engines.js`) | Main | Cloud API address, key and status |

### The Showdown bridge

Launcher pages ask main for a snapshot. Main runs `readClient()` inside the client page and sanitizes the result (IDs by regex, length-capped strings, checked sprite paths) into user, formats, teams, news, rooms and friends. Actions go the other way: search, cancel, challenge, join, focus-room, leave-room, edit-team, login, sounds, options. Each is validated against an allowlist, and arguments travel as JSON, never spliced into code. A session read sets `html.sd-launcher-shell` only when every client hook the shell needs exists. Otherwise the class is withdrawn and Showdown's own header and tabs come back (G2).

### Storage

| Data | Location | Notes |
| --- | --- | --- |
| Settings, window state | Electron userData (`%APPDATA%\showdown-desktop`) | Atomic writes (temp file, then rename) |
| Replay notes | userData `replays.json` | Versioned; a corrupt file is reported and never overwritten |
| Showdown login, teams, preferences | Partition `persist:showdown` | Separate from launcher data |
| Logs | userData | Fixed event names and numeric codes only |

`SHOWDOWN_DESKTOP_USER_DATA` selects an alternate profile for isolated tests.

### Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Main-process modules, preload, injected client, replay and Showdex CSS |
| `renderer/` | Launcher pages (Home, Showdown, Practice, Replays, Settings), shared nav and styles |
| `api/` | Practice API: server, client, Foul Play installer and worker, deployment files ([README](../api/README.md)) |
| `scripts/practice/`, `scripts/bots/` | Practice simulator wrapper and runtime builders; the desktop bot suite |
| `vendor/practice/`, `vendor/showdex/` | Source pins, licenses, locks, patched practice client shell |
| `tests/` | Unit tests, Electron desktop and live drivers |
| `docs/` | This document and [bots.md](bots.md) |

## 4. Feature details

### Daily Foul Play

Home includes a compact cobalt Daily Foul Play strip in both layouts, with a yellow flame tile, highlighted active streak, remaining attempts, a Play daily action, and a Details link to Bots. The fuller challenge panel on Bots holds rules, best streak and total clears, and can also start or resume a daily attempt. Win one Gen 9 Random Battle against Foul Play Medium in at most three attempts per UTC calendar day. A clear adds exactly one day to the streak and locks further daily play until 00:00 UTC. Missing a day or finishing all three attempts without a win resets the current streak; personal best and total daily clears remain. Ordinary practice does not count and remains available.

The card offers Start challenge or Return to challenge, remaining attempts, current/best streak, lifetime clears, and the rules. Daily battles use the existing battle tab, with a guarded daily retry after a loss. Each retry starts a fresh session and random teams. Finish before midnight UTC: a late result cannot clear either the expired challenge or the next day's challenge. Ties and deliberate exits from active battles consume an attempt; cancelling setup or a detected runtime/engine failure refunds it. The app cannot resume a simulator after restart: an interrupted active attempt counts, while interrupted setup is refunded.

Progress is private to this launcher profile, stored atomically in `daily-challenge.json`. It uses the computer's UTC date, not an authenticated service clock. Backwards clock changes block new attempts until the stored day is reached; this is personal progression, not a tamper-proof competition or cross-device account system. Renderer IPC can request a start or read status, but cannot submit a result, choose the daily opponent, or edit counters. The main-process controller observes the simulator bridge. Corrupt files are preserved and disable challenge play; save failures fail closed. Reset settings/replay notes keeps daily progress, as the confirmation states.

Verification: daily state tests cover streaks, three attempts, ties, missed days, midnight, backwards clocks, duplicate results, restarts, failure refunds and failed/corrupt persistence. The isolated daily desktop test exercises real IPC and Home/battle navigation with simulated outcomes, captures both layouts/themes at both window sizes, and blocks public-client requests.

### Launcher shell and Home

- **Icon bar:** an 84px cobalt bar on the left; each page (Home, Teambuilder, Stats, Replay notes, Practice, Settings) is an icon with its name underneath, and the account avatar and name sit at the foot.
- **Page tabs:** the tab strip across the top of every page starts with small, label-width tabs for launcher pages, as in Showdown's own header. Home is always first and cannot be closed. Opening Stats, Replay notes, Practice or Settings from the icon bar adds its small tab after Home; it stays until closed or the app restarts, and closing the page being shown moves to the tab on its left. Teambuilder is the client's own room: its small tab is shown exactly while that room is open, and closing the tab leaves the room. **Community** (the client's main menu in its Community view, with its chat room list) also opens from the icon bar; its small tab appears whenever that view shows and stays until closed. Closing it while it shows switches the client back to its Battle view and opens Home; elsewhere it only drops the tab. **Info & Resources** is a launcher page (`resources.html`): the help, tier and clause explanations, chat commands, ranks and shortcuts are written into the page, so nothing is fetched. The client's own resources room (Community's Info & Resources button) is closed as soon as a session read sees it, and this page opens instead. **Practice battle** opens when a practice battle starts and exists while that session does; closing it ends practice, asking first in the same forfeit popup while the battle is on. A wider gap separates these from the room tabs. **Ctrl+Tab** opens the tab to the right of the open one and **Ctrl+Shift+Tab** the one to its left, through page tabs, rooms and conversations, wrapping at the ends. **Ctrl+1** to **Ctrl+8** open that tab counted from the left (Ctrl+1 is always Home) and **Ctrl+9** opens the last one. **Ctrl+W** closes the open tab and a **middle click** closes the tab under the pointer, both exactly as the tab's close button would, so a live battle of your own still asks before forfeiting; Home has no close button and ignores both. The main process catches the keys, so they also work while the focus is inside the Showdown client, a replay or a practice battle.
- **Room tabs:** the normal-sized tabs that follow. One tab per open room (battles, chats, ladder) in the client's order with a close button, then conversations after a Messages label. There is no Battle tab: Home replaces the client's main menu. If the Showdown screen is left on that menu (for example after closing a room), it returns to Home once two session reads agree, unless a client popup is waiting. Tabs sit flat on a darker strip with a short hairline between neighbours; the open tab takes the page colour, close buttons are always visible, and the hairlines beside it or beside a hovered tab drop away. Tabs share one width (up to 150px), shrink together to a 104px minimum, and then the strip scrolls (the mouse wheel scrolls it sideways). Closing an own live battle asks **Forfeit this battle?** in a small popup under the tab's close button (Forfeit or Cancel, as Showdown does; it fits over the top bar, since a battle view covers the page below), then sends the client's own `/forfeit` and leaves the room in the background, so the battle is never brought back on screen just to confirm. Other rooms close through the client's own leave path.
- **Persistence:** the client stays loaded across page changes, so navigating never loses a battle. A newly started battle switches to the Showdown view and takes priority. Home shows **Return to battle** while one runs. An ended battle shows a result bar: **Save replay note**, **Close battle**, **Battle again**.
- **Home hero:** format and team pickers (with the team's sprites: Showdown's 2D gen 5 style sprites, drawn pixelated, rather than the Teambuilder's 3D Pokémon HOME renders), **Battle**, **Cancel** and **Challenge a user**. Search runs in the background with an animated state. Choices are remembered per format as a convenience only.
- **Home hero record:** the selected format's rating, win rate, win–loss record and GXE, from the public profile endpoint (cached 2 minutes), with user and battle counts and **Edit teams** (opens the selected team).
- **Home layouts:** two layouts on one page, for two kinds of player. Either one shows the same hero, news and chat rooms; only the arrangement differs.
  - **Classic** (Showdown's main menu, modernised, for existing players): the hero as a column on the left with **Tournaments**, **Ladder** and **Spectate** tiles beneath it. On the right, **Latest news** over **Chat rooms** and **Friends** side by side, ending level with the tiles.
  - **Revamped** (for new players): one centred column, 820px at most. A wide hero with the record and **Teambuilder**, **Ladder**, **Watch** and **Your stats** shortcuts inside it, then **Latest news** and **Chat rooms** split 70/30. No friends window.
- **First-launch welcome:** shown on the first launch after installing, not on Showdown sign-in: it depends only on launcher settings, never on the Showdown account. While no layout is chosen (`homeLayout` is null), Home opens a modal with a small labelled copy of each layout (battle panel with **Battle!**, news, chat rooms, friends, shortcuts) in its real proportions, and says either can be changed in Settings. It cannot be dismissed without choosing. The choice is saved to launcher settings, so it is asked exactly once; only **Reset launcher** clears it. If settings cannot be read, Home shows Revamped and does not ask, since the answer could not be kept.
- **News:** each post in **Latest news** opens in place to its full text (click again to close) and stays open through Home's refreshes. The bridge reads a post as paragraphs of plain-text runs and links; links must be http(s) and are otherwise kept as text, and the post is bounded (20 paragraphs, 6,000 characters). Home never inserts the page's HTML. Links to a Showdown room (`play.pokemonshowdown.com/<room>`) join that room in the app; other links, **Open on pokemonshowdown.com** and **All news** open in the system browser.
- **Chat room shortcuts:** until edited, the five busiest rooms. **Edit** pins that list and lets the player remove rooms or add one by name (up to 12, duplicates ignored); from then on the list is theirs. Kept in the launcher page's local storage as a convenience.
- **Stats page:** a rail page with ladder totals (battles, win rate, highest rating, most played) and a sortable, filterable per-format table of rating, win rate, wins, losses, battles and GXE. **Play** on a row preselects that format on Home; it never starts a search.
- **Restyled client rooms:** the Ladder, Teambuilder, Community view, chat room list, live battle list, chat rooms, battle rooms and tournaments are the client's own pages restyled in place by `app/client-ladder.css`, `client-teambuilder.css`, `client-community.css`, `client-rooms.css`, `client-chat.css` (chat rooms), `client-battle-room.css` (battle rooms) and `client-tournament.css` (the tournament bar, bracket, tools, notices and bracket pop-out). They change surfaces, type and layout only; the client's markup and controls are untouched, and every rule is scoped to `sd-launcher-shell` so the client's own look returns if the bridge stops driving it. Battle rooms follow the "Cobalt Cards" mockup: the field, controls and log as separate square-cornered cards; a header row with the gimmick toggles (Mega, Z, Ultra Burst, Dynamax, Tera) and the timer; type-tinted move tiles with a type chip and PP (a type-coloured top edge in dark); switch cards with an HP bar and Active/Fainted notes; HP bars on the field with no card behind them; turn markers in the log. Every corner is square. The card layout applies only in the client's full layout (at least 830px wide and 571px tall); smaller windows keep the client's compact layouts with the same colours. The same rules apply to practice battles (scoped by `data-practice-state`). They are a separate stylesheet, injected only while Settings > Battle screen is Launcher style; choosing Showdown's original removes it live from the client and any practice battle. In the card layout a handle between the field and the log sets the width of the left column (640px up to whatever leaves the log 300px; a double-click resets it). The action picker stretches to the column, with its move tiles and switch cards (and their HP bars) widening; the field keeps its 640x360 size, centred on a backdrop as wide as the column. `app/battle-resize.js` adds the handle and backdrop in the client and in practice battles and sets `--sd-battle-width`; when a drag ends it logs the width to the console, and main saves it as `battleWidth` and passes it to the other view.
- **Friends pages:** the server's own `/friends` pages (All Friends, Spectate, Sent, Received, Help, Settings; rooms `view-friends-*`) restyled in place by `app/client-friends.css`, with the same scoping as the other client rooms. A **Friends** title over an underlined tab bar with **Refresh** at its right; friends as cards in a grid under status headings, with status chips in the app's colours; an inline **Add friend** field; request rows with **Accept** filled and **Deny** plain; settings as a label beside a two-choice segmented control, the current choice filled (Showdown marks it by disabling that button). The tab strip and top bar call every friends page **Friends**, with the page name as the top bar's status. **Open list** opens the page room at once (showing "Loading…" until the server's page arrives) or focuses an open one; it never passes through the main menu. **Challenge a user** likewise opens that user's conversation with the challenge form, not the bare main menu. `npm run test:desktop` renders each page from the server's markup, since the real pages need an autoconfirmed account the tests never use.
- **Responsiveness:** Home never waits on the network. Its read waits at most 150 ms for ratings and friends; anything slower finishes in the background while Home shows the last known values (or "Loading friends…"), then asks again after a second. Team sprites are worked out once per team (remembered by its packed text) rather than on every read, since that work runs in the page that also runs battles. Each launcher page draws its tab strip from the window's last session read at once, so switching tabs never flashes an empty strip. When the client opens or switches rooms itself (Community's room list, a link in chat), its address changes; main forwards that as a data-free `client:changed` cue and the page reads the session immediately, then once more 350 ms later for the room's title from the server, instead of waiting up to a second for the next poll.
- **Friends panel:** structured presence (online, idle, busy, offline as reported), refreshed at most every 30 s. **Open friends list** is the fallback. No battle state or avatars are inferred.

### Showdown client

- The official `play.pokemonshowdown.com` client in a persistent partition, so sign-in survives restarts.
- The injected theme follows Appearance and preserves Pokémon type, HP and stat colors.
- External links open in the system browser. Only Google sign-in may open a popup.

### Replay notes

- **Notes:** paste a link from Showdown's **Upload and share replay**, add a title, format and notes, and save. **Save replay note** on a battle prefills players and format but never uploads. Private links keep their access suffix.
- **Limits:** title 120 characters, notes 5,000, collection 1,000 entries / 8 MiB. Saved links are read-only. Adding a duplicate link offers the existing note.
- **Search and shortcuts:** search matches titles, formats and note text. **Ctrl+F** focuses search, **Escape** clears it, **Ctrl+S** saves.
- **Drafts:** unsaved drafts survive navigation. Closing the app with a draft asks before discarding it. Deleting a note never touches the hosted replay.

**Replay review.** **Review replay** opens the official replay page beside the same note editor. Showdown's player provides all playback; the app reconstructs nothing.
- **Controls:** **Hide notes** widens the player. **Reload replay** reloads only the replay. **Back to notes** closes the player and stops audio. **Open in browser** is explicit.
- **Locked to one replay:** main resolves the note ID to its validated URL; the renderer never supplies a URL. Navigation is limited to that exact replay path plus upstream playback parameters. If the page moves to a different replay, the view stops.
- **Failures and limits:** network, HTTP and renderer failures show an error with an explicit reload. Playback position is not kept.

**Backup and restore.**
- **Export notes…** writes every saved note (ignoring filters, excluding drafts) to versioned JSON through a native Save dialog. It refuses destinations inside the live profile, and a failed write keeps the previous file.
- **Import notes…** reads a file into a validated snapshot and opens a review window:

| Result | Meaning | Default |
| --- | --- | --- |
| New | No saved note has this exact link | Added with its saved dates |
| Unchanged | Link, title, format and notes all match | Skipped |
| Conflict | Same link, different content | Keep existing; per-note or bulk **Use imported** |

- **Applying an import:** it is one atomic write, and notes missing from the file are always kept.
- **What blocks it:** the file must pass validation as a whole (version 1, ≤ 8 MiB, no duplicates, valid URLs and dates); nothing is truncated or silently skipped. A preview goes stale if saved notes change meanwhile, and an open draft must be saved first.
- **Undo import…** restores the collection from before the last import that changed notes. It is available only within the app session and only while notes are unchanged. Session undo is not a backup history.

### Practice

- **Opponents:** Gen 9 Random Battle and OU on a private simulator the app starts on the player's computer. The Bots page has format tabs (**Random Battle**, **OU**) and one collapsible group per difficulty, hardest first: **Hard** (Foul Play), **Medium** (Foul Play Medium, Foul Play Casual) and **Easy** (Heuristic, Greedy, Random). The weaker levels are Random Battle only. The OU tab lists Foul Play only. Every card is the same size: icon and name, type and formats, a description and its own **Play** button. Nothing on the page says "unrated"; practice never touches the online account.
- **Where the bots run:** the simple bots run inside the app, offline ([bots.md](bots.md#simple-bots-appsimple-botsjs)). Foul Play, at every level, always runs on the cloud server, with nothing to install; only its cards show the server's state (online, busy, unreachable).
- **OU teams:** above the Hard group, a **Teams** section has two equal slots, **Your team** and **Foul Play's team**. Each takes an OU team from the Teambuilder (**My teams**) or a pasted export (**Paste a team**); the same team can go on both sides. There are no built-in or sample teams. Both teams are checked with the practice simulator's validator as they are chosen; Play stays disabled until both are legal, and an illegal or unreadable team shows the reason under its slot. The page remembers the last Teambuilder teams chosen; pasted teams are not saved. **New battle** keeps both teams. Teams are used for the game only, never kept or logged ([bots.md](bots.md#ou)).
- **No computation setting:** Foul Play always asks for the **Full** preset and gets what the server allows (currently 2 threads). The presets only ever set search threads, not strength, so the page no longer offers them.
- **Battle tab:** a card's **Play** opens a **Bot battle** tab (`practice-battle.html`) showing only the battle: the client's own header and room tabs are hidden, so the battle cannot be closed from inside it and leave an empty client. While a battle runs, the Bots page offers **Go to battle** instead of starting another.
- **Controls:** moves, switches and Terastallization in the battle; **Forfeit** (opens the client's confirmation), **New battle** after it ends, and **End practice** in the tab's header. Status shows starting, thinking, turn, elapsed time and result.
- **Account separation:** practice and online games stay loaded side by side, and the online account is never involved.
- How the bots decide, every protocol layer, performance and deployment: [bots.md](bots.md).

### Showdex (optional)

- **Build:** `npm run build:showdex` checks out Showdex 1.4.2 at a pinned revision and applies a recorded readiness patch. It verifies every asset against a committed SHA-256 manifest. Sources and the AGPL-3.0 license are in `vendor/showdex/SOURCE.md`.
- **First launch:** after choosing a Home layout, new users can choose Install Showdex or Not now. The answer is saved; existing profiles are not prompted on upgrade, and resetting settings does not repeat the Showdex offer. Skipping leaves Showdex disabled and creates no installed copy. Settings offers Install Showdex later.
- **Installation:** the app carries an inert, pinned payload plus its AGPL license and corresponding source archive. `ShowdexInstaller` copies into a staging directory under the profile, verifies runtime assets against the shipped manifest, and promotes the copy into `showdex/1.4.2`. Failed installs preserve an existing copy and leave a retry available. No terminal, external installer or download is needed. Installed files include the license, source record and source archive.
- **Enabling:** explicit installation enables Showdex and injects it into the existing client without reloading a battle. Later toggle changes retain the explicit client reload flow. Status reads Loaded only after Showdex has rendered; installation success alone does not claim it loaded. A failure leaves normal play intact. Existing developer opt-ins can still use the verified source-checkout bundle.
- **Look:** its chrome follows Appearance; calculator behavior and game colors stay upstream. It is excluded from packages until its distribution licensing is decided.
- **Battle dock:** `app/showdex-dock.js` arranges the existing Calcdex root to the right of chat: battlefield, chat, calculator. The battle's Showdex button hides/reopens it; selecting a Calcdex tab opens its matching battle. Both native panel and overlay modes are supported without changing the pinned bundle or saved Showdex preferences. Below 1250px of client width, chat moves below the battle controls in a scrolling column while the calculator stays visible on the right. The field scales to fit. Closing or switching battles removes the active dock; the online shell fail-safe restores native placement.
- **Bot battles:** installed/enabled Showdex is loaded into each new isolated practice session, with the same dock (battle, log, calculator). The scheme handler is registered before creating its renderer; only hash-verified assets and read-only Gen 9 Random Battle/OU preset and usage JSON endpoints are added to its request allowlist. No login/account requests or arbitrary external fetches are allowed. The practice CSP explicitly permits the Showdex scheme and metadata host; it is not bypassed. A battle received before Showdex finishes booting is initialized from its existing state without replaying turns. Changes to the global Showdex toggle apply on the next bot session. Optional asset setup failure leaves the battle playable.
- **Dock verification:** `npm run test:showdex:dock` loads the real client and Showdex in an isolated guest profile with synthetic received battle logs. It checks both themes, three window sizes, hide/show, tab navigation, native overlay mode, battle HP synchronization and cleanup. Outbound sends are intercepted. This is integration coverage, not a signed-in public battle test.
- **Bot verification:** `npm run test:practice:showdex` installs the real pinned Showdex bundle and starts a real Foul Play battle through the simulator and a loopback instance of the inference API. It asserts nonzero calculated damage ranges, column order, move/switch/Tera handling, both themes/window sizes, rematches, and session cleanup. No public ladder battle or account is used.

### Settings

- **Options:** Appearance (system, light, dark), Home layout (Classic, Revamped), Battle screen (Launcher style, Showdown's original), start page, close protection for battles and searches, explicit client reload, open logs.
- **Sign out** clears the Showdown partition, including local teams (export them first). **Reset launcher** clears settings, preferences and replay notes but keeps the Showdown session. Both confirm first.
- **Window:** size, position and maximized state are remembered. A saved window is repositioned if its monitor is gone.

## 5. Key decisions

| # | Decision | Alternative | Rationale |
| --- | --- | --- | --- |
| D1 | Host the unmodified official client | Fork or re-implement it | Stays current with Showdown; added layers can fail without breaking play (G2) |
| D2 | Reach the client only through a sanitized, allowlisted bridge from main | Give remote views a preload or Node | The client is remote content; a fixed list of named actions bounds the attack surface |
| D3 | Separate `persist:showdown` partition | Share launcher storage | Sign-in survives restarts; Sign out and Reset launcher clear one without the other |
| D4 | Launcher-owned room navigation, with a fail-safe | Keep Showdown's own tabs | One consistent rail; if client hooks change, the client's tabs return automatically |
| D5 | Replay notes store links, not replays | Download replay archives | Showdown hosts replays; local data stays small, private and portable |
| D6 | Import reviews conflicts and keeps existing notes by default | Overwrite or mirror the backup | Restoring must never silently lose notes |
| D7 | Foul Play plays on the hosted API by default; running it on the player's computer is an opt-in download | Bundle Foul Play with every release; cloud only | Owner decisions (2026-11-13, 2026-11-17 evening): Foul Play is too large for the base release and the hosted API serves everyone regardless of CPU, so the cloud stays the default. The morning of 2026-11-17 local play was removed to keep GPL-3.0 code out of the app; that evening it returned as an opt-in, since the project's license (AGPL-3.0-or-later, matching the shipped AGPL client) is compatible with Foul Play's GPL-3.0 |
| D7a | The simulator runs on the player's computer; only inference is remote | Run whole battles on the server | Owner decision (2026-11-16): a server that only searches, and a battle UI that never depends on the network. Foul Play only for now; anonymous access with rate limits |
| D7b | Host the cloud API on one VM behind Caddy, named through sslip.io | Own domain; managed containers; Docker on the VM | Owner decision (2026-11-16): no domain to buy or manage, and a plain systemd service is simple to update with `git pull`. The hostname is derived from the static IP, so changing the IP means a new app build |
| D8 | Practice on a private simulator with loopback enforced twice | Bot plays on the public server | Automated play on real accounts is impossible by construction ([bots.md §3.4](bots.md#34-network-confinement)) |
| D9 | Presets are thread counts, not offered on the page | Named difficulty levels; a Computation picker | That is all they change; strength is not measured, and the server caps them anyway |
| D10 | Every third-party input pinned by revision or hash | Track upstream | Reproducible builds and a recorded license position per component |

Bot-internal decisions (thread pools, rejected-choice handling, pooling) are recorded in [bots.md](bots.md).

## 6. Security and privacy

- **No automated play on real accounts.** The app and its tests never search, challenge or play on the user's account. Live tests are guest-only and spectate.
- **Least privilege per view.** Only launcher pages have a preload. Remote views are sandboxed and context-isolated and deny permissions; downloads and popups are blocked. The Showdown client is denied notifications; the launcher shows them itself.
- **Electron fuses.** Packages disable `NODE_OPTIONS` and `--inspect`, load the app only from a hash-checked `app.asar`, and encrypt cookies (the Showdown login) with the OS key store. `runAsNode` stays on because the practice simulator runs as an `ELECTRON_RUN_AS_NODE` child.
- **Validated IPC.** Every privileged request is validated in main. The renderer never supplies file paths (native dialogs choose them) or replay URLs (main resolves them from note IDs).
- **Text, not HTML.** Imported and snapshot text is rendered as text.
- **Private logs.** Fixed event names and numeric codes only: no usernames, credentials, replay URLs or note text.
- **Practice API.** Session IDs are 256-bit capabilities and are never access-logged. The local API binds to 127.0.0.1 with a per-launch key and refuses browser upgrades. Choices from any API are checked against the move grammar twice (server and app) before reaching the simulator. The hosted API listens only on loopback behind Caddy, which keeps no access log, and rate limits use the client address Caddy forwards.
- **Explicit destructive actions.** Sign out, reset, discarding drafts and undoing imports all confirm first.

## 7. Testing

### November 19 final Evolved audit

The visible product name is **Pokemon Showdown Evolved**, including page titles,
onboarding, notifications and future Windows package names. The application ID,
npm package name, environment variables and profile directory remain stable for
existing users. The profile test covers both old and new product names.

Verified on the development PC:

- Syntax checks and 241 tests passed with no skips when
  `PRACTICE_TEST_SERVER_ROOT` points at `vendor/practice/dist/server`.
- All nine isolated desktop suites passed, as did guest live shell, Showdex,
  Showdex dock, official replay playback and real Foul Play/Showdex practice.
- Two full hosted Medium Random Battles completed (26 and 22 turns; 50 decisions,
  median 118 ms). Two loopback Hard OU battles completed (16 and 32 turns;
  52 decisions, median 235 ms). Rematches and cleanup passed.
- The new `npm run test:startup:live` checks guest startup, both themes, all six
  launcher pages, horizontal overflow, broken images and launcher console errors.
  Its sample measured Home ready 239 ms from harness entry, connected client and
  formats at 2.23 s, and page navigation at 19–83 ms. These are warm development
  measurements, not cold installed-app or low-end hardware guarantees.
- App (full and production), API and bundled simulator production npm audits
  reported zero known vulnerabilities. Package source/runtime verification passed.
- README media were visually inspected: actual guest/practice captures, the owner
  logo and an attributed Showdown Eevee sprite. Generated test output stays ignored.

Fixed deprecated Electron console handlers and bounded practice API JSON while
streaming, so an oversized response is cancelled before buffering the rest.
Regression tests cover cancellation, UTF-8 byte counts and invalid responses.
Practice's blocked ladder/account and unrelated Showdex API requests are expected
isolation behavior; actual calculations and battle controls passed.

No public account battles, account challenges, server deployment, installer rebuild
or clean-machine acceptance were performed. Signed-in verification and installer
acceptance remain release requirements. This audit is not a guarantee against
future upstream client changes.


Electron is pinned to 45.3.4. The dependency override upgrades only affected
`minimatch` versions (7 through 11.0.0) to 11.0.1 for GHSA-g3hv-75wg-m249;
older unaffected consumers retain their compatible APIs. The build dependency
test exercises electron-builder's actual file filters and the universal build
allowlist matcher without creating an installer. Reassess the override when
updating electron-builder. The live shell test waits for battle metadata as well
as the tab: the server can deliver the initial turn after the tab appears.

November 18 release follow-up: added a per-profile single-instance lock, verified
by starting a second Electron process, so concurrent launchers cannot overwrite
each other's settings and notes. Canonicalized IPv6 network keys (including
embedded IPv4) and rejected invalid forwarded addresses in the practice API.
The top-level npm audit did not cover the bundled simulator: its separate scan
found four affected packages, including a critical websocket-driver advisory.
The simulator now uses a committed production dependency lock with mysql2
3.24.6, websocket-driver 0.7.5 and uuid 11.1.1. Packaging checks both dependency
files against the runtime inventory and requires a rebuild after changes.
Upstream game source remains at its pinned revision. The rebuilt simulator's
production audit reports zero vulnerabilities, as do the app and API audits.
Showdex's right-panel navigation now focuses the tool in the launcher's single
panel, with upstream behavior retained when the shell fail-safe disengages.

224 unit tests passed (one optional skip), and all seven desktop suites passed
after the instance-lock change. Guest shell, replay and Showdex checks passed;
real loopback practice passed again against the rebuilt simulator. An isolated offline sample
measured a 208 ms warm development launch, 17–53 ms page loads, a 5 ms maximum
session IPC round trip and 31 ms main-loop p99 delay. These do not measure
network latency or clean-machine performance. No real-account actions or
production server changes were made.

The follow-up unpacked Windows build passed both packaged smokes, including a
real move through the hosted practice API, navigation retention, forfeit/rematch
and process cleanup with a restricted PATH. Its isolated startup sample was
429 ms; the practice battle was ready in 3.1 s. New dependency pins and their
builder use fixed LF line endings so Git checkout does not invalidate the byte
inventory. This is not a clean-machine installer or signed-in acceptance test.

Earlier November 18 launch audit: 222 unit tests (one optional skip), all seven desktop
suites, the practice suite (a real Foul Play battle), live shell and replay checks,
two battles against the hosted API (median 240 ms per decision), and both packaged
smokes with fuses on. Three desktop suites had gone stale against current behavior
and were updated. Guest performance: Home ready 195 ms after launch, client
connected 4.7 s, every page 17–65 ms in both themes. Of about 1.1 GB working set,
about 320 MB is three ad iframes Showdown's own page loads. npm audit: zero.

November 16 audit follow-up: syntax, 152 unit tests (one optional skip), all seven
isolated desktop suites, live shell and live replay review passed on Electron
45.3.3. Full and production-only npm audits reported zero vulnerabilities. A
fresh guest performance probe measured Home ready at 180 ms from script entry,
the connected shell at 2.8 s, and page navigation at 25–74 ms in both themes and
window sizes. These are development-PC samples, not cold installed-app startup,
low-end hardware or sustained-memory guarantees. No installer was rebuilt and
no hosted bot deployment was changed.

November 16 practice API deployment: 157 unit tests (one optional skip) and
`npm run check` passed. `tests/practice-api-live.cjs --url` played two full
battles from a development PC against the hosted server over HTTPS (11 and 25
turns, 38 decisions, median 248 ms per decision at 2 threads). The Electron
practice suites were not rerun against the hosted server.

| Command | Covers |
| --- | --- |
| `npm run check` | Syntax |
| `npm test` | Unit tests: bridge sanitization, action validation, navigation timing, challenges and messages, settings, replay storage and imports, practice manifest, runtime and session bridge, practice API server and client, bot integrity |
| `npm run test:desktop` | Electron suites with temporary profiles and simulated Showdown responses (outbound client traffic blocked): connection recovery, view survival and sizing, themes, battle auto-switch, replay notes, review and import. Screenshots go to `out/desktop-smoke/` |
| `npm run test:shell:live` | Guest, spectate-only drift check of the client hooks the shell depends on. Run before each release |
| `npm run test:showdex:live`, `npm run test:replays:live` | Guest-only checks of a real Showdex build and a real public replay, in both themes and sizes |
| `npm run smoke:packaged` | The unpacked package with a fresh profile, system-only PATH and the public client blocked |
| Bot suites | Real games against Foul Play through a loopback copy of the API server or the hosted one (`--url`), ([bots.md §6](bots.md#6-running-and-hosting)) |

No suite verifies a signed-in account. Those checks are manual and owner-only (section 9).

## 8. Build, packaging and release

**Run from source** (Node.js 24):

```sh
npm install
npm start
```

For Showdex development, run `npm run build:showdex`; new users can then install it during setup or from Settings. Packaging now requires this verified payload, including its license and source archive.

**Packaging** (`electron-builder` 26.18.0, always `--publish never`):

```sh
npm run build:practice   # required: packages bundle the practice simulator and battle client
npm run pack:win:dir     # unpacked app for inspection
npm run smoke:packaged
npm run smoke:practice-packaged
npm run pack:win         # unsigned per-user x64 NSIS installer in out/windows/
```

- **Installer:** adds a Start menu shortcut but no desktop shortcut, and uses Electron's default icon until branding is decided.
- **`app.asar`:** contains `app/`, `renderer/`, `api/client.js`, `api/protocol.js`, `package.json` and the optional Showdex installation payload with license and source archive. It never contains tests, scripts, `out/` or credentials. Showdex is not installed into the profile or enabled until the player opts in.
- **Foul Play is not in the release** (D7). It plays on the cloud server unless the player downloads it from the Bots page. For that opt-in, the app ships `api/client.js`, `protocol.js`, `install.js`, `server.js`, `lock.json` and the GPL-3.0-derived worker `api/worker/foulplay_worker.py`, unpacked from app.asar so Python can read it. The after-pack check fails the build if any other `api/` file is packaged or anything else is unpacked. No Python or Foul Play ships; the download fetches the pinned Python, Foul Play source, packages and set data.
- **Practice simulator runtime:** `build:practice` builds only the pinned Showdown server, the patched battle client and their source archives (a `simulator` manifest, about 290 MB). It ships outside the archive under `resources/practice`, with `server.cjs` alone under `resources/practice-adapter`. Before- and after-pack hooks re-verify every file and refuse any other runtime kind, and packaging fails on any drift.
- **Dependency audit:** `npm audit` reports zero vulnerabilities for the app and `api/`.
- **Fuses:** set in `electron-builder.yml` (see section 6); `npx @electron/fuses read --app <exe>` shows them.

**Release path** (original plan; see the automatic-update section below for current behavior).

1. Prove a clean Windows 11 install, upgrade between two versions, uninstall and reinstall, as a standard user at 100% and 125% scaling.
2. Decide Showdex inclusion and meet the AGPL/GPL source obligations (project license: AGPL-3.0-or-later, decided 2026-11-19).
3. Settle app identity (icon, publisher name) and code signing.
4. Build reproducible, versioned GitHub Releases with checksums, notices and install notes.
5. Run an invited alpha with 8–12 Showdex users, fix launch, data-loss and battle-interruption defects, then publish a public alpha.
6. Add automatic updates once manual upgrades are proven. Never restart during a battle.

## 9. Status, risks and open questions

**Status** *(snapshot)*

| Area | State |
| --- | --- |
| Shell, Home, client, replay notes, review, backup, Showdex, settings | Implemented; automated suites pass |
| Practice (Foul Play) | Implemented: cloud by default, opt-in local download |
| Hosted practice API | Live on one Google Cloud VM over HTTPS; two real battles verified end to end. Docker image untested |
| Windows installer | Builds and passes packaged smoke tests; never tested on a clean machine |
| Public release | Not started |

**Risks**

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Showdown client changes | Bridge reads or theme selectors break; a switch to Showdown's new Preact client would need a bridge rewrite | Fail-safe shell; `test:shell:live` before releases |
| Licensing | AGPL/GPL obligations for the patched client, Foul Play and Showdex | Source and notices retained; owner review before release |
| Hosted API capacity and reachability | One VM serves 8 battles at once at 2 threads; anonymous access invites abuse; the sslip.io hostname breaks if the static IP is released | Per-network rate limits and caps; tests use a loopback copy of the server; keep the IP reserved; add `API_KEY` or accounts, more VMs, or a domain if usage grows |
| Unproven demand | Users may not return | Invited alpha measures return use before more features |
| Local Foul Play supply chain | Downloads are SHA-256 pinned, but pip packages are pinned by version only and poke-engine's build dependencies (maturin) and crates resolve at install time | Add `--require-hashes` pins and a pinned, hash-checked build backend before promoting local play |

**Open decisions (owner)**

- [x] Project license: AGPL-3.0-or-later (2026-11-19), compatible with the patched AGPL client, GPL-3.0 Foul Play and AGPL Showdex.
- [ ] Code signing and release branding.
- [x] Showdex is an optional first-launch installation from a bundled payload; packaging includes source and license. The installer has not been rebuilt for this feature.
- [ ] Whether the hosted API stays anonymous, and whether it moves to a proper domain (the current hostname is tied to the VM's IP).

**Verification outstanding**

- [ ] Signed-in checks by the owner: session persistence, ratings, team selection, challenges, a real search becoming a battle, friends data, rail forfeit prompt, result bar.
- [ ] Clean-machine install, upgrade and uninstall (release step 1).
- [ ] The Docker image (`api/deploy/`), and the in-app Foul Play install on Windows and macOS.
- [ ] The Electron practice suites against the hosted server, and its behavior with several players at once.

**Not designed yet:** incoming challenges and PMs inside the launcher, a replacement for Showdown's own home screen, Practice view chrome, practice formats beyond Gen 9 Random Battle, macOS and Linux packages.

## 10. Appendix: visual design

Two themes share one identity: a cobalt rail, a cobalt Home hero and a Showdown-yellow primary button. Light is **Cobalt**; dark is **Steel blue**, deliberately blue rather than charcoal or grey. Components use role tokens only. A color change edits both theme blocks of `renderer/styles.css` and the matching `--sd-*` value in `app/client-theme.css`.

| Token | Cobalt (light) | Steel blue (dark) | Use |
| --- | --- | --- | --- |
| `--bg-app` | `#e6ecf5` | `#24304a` | Window background |
| `--bg-panel` | `#ffffff` | `#2c3a57` | Panels and cards |
| `--text` | `#15223a` | `#f1f4fa` | Primary text |
| `--accent` | `#2459b8` | `#7db2ff` | Links, focus, selection |
| `--primary` | `#f5c42c` | `#f5c42c` | One primary button per region |
| `--rail-bg` | `#1f4b9a` | `#193f85` | Navigation rail |

### Publishing the first Windows preview

The v0.2.0 GitHub prerelease uses the owner-supplied Eevee logo for the app,
installer and uninstaller. `renderer/assets/app.ico` is a format conversion of
`logo.png`, with 16, 24, 32, 48, 64, 128 and 256 px images. `win.icon` controls
the executable; the NSIS icon options control setup, removal and its header.
The BrowserWindow also explicitly uses that icon during development.

Publish from a clean, committed tree: build, run both packaged smoke commands,
record the source commit and SHA-256, push an annotated version tag, create a
draft release, upload the installer and checksums, inspect its assets, then
publish as a prerelease. Keep each public version fixed; changes get a new
version and tag. GitHub provides source archives for the tag, and the installer
retains bundled upstream licenses and corresponding source archives.

The original public 0.2.0 files use manual updates. The replacement candidate below adds guarded updates. Clean-PC installation/uninstallation and signed-in acceptance testing remain pending. Windows remains unsigned. No app telemetry is added.

Download counts are available without app telemetry through GitHub:

```powershell
gh api repos/influxtion/Pokemon-Showdown-Launcher-App/releases/tags/v0.2.0 --jq ' .assets[] | {name, download_count}'
```

Count the installer asset separately from checksum/source downloads. Downloads
are not unique users or successful installations. Repository Insights > Traffic
provides a rolling 14-day visitor/clone window; save snapshots if long-term
traffic history is needed.


## Automatic updates (November 19, 2026)

The replacement 0.2.0 candidate uses pinned `electron-updater` 6.8.11. Installed Windows NSIS and Linux AppImage builds check GitHub Releases 30 seconds after startup and every six hours, including preview releases. Downloads are automatic and hash-checked. Settings also offers Check for updates, shows progress/errors, and exposes Restart to update only after the download completes. A small rail label points to Settings when an update is ready. Development builds never check; Mac and unpacked Linux builds link to the Releases page. The owner chose manual Mac updates because no Developer ID certificate is available.

`app/updates.js` owns update state and sets `autoInstallOnAppQuit=false` before any download. No download, ordinary quit, or elapsed timer installs anything. Installation requires an explicit click and a native confirmation. Main checks current session state both before and after that confirmation, with bounded reads. It refuses unknown/disconnected client state, all unfinished battle rooms (including spectators and rooms whose player names have not arrived), pending searches/challenges, starting/active practice, unsaved replay state or a cached draft, and conflicting installs/imports/exports. The restart action is available only while Settings is the current fully loaded page, so the user cannot type into a note during the final checks. Failed reads block installation. Existing profile paths and saved data stay unchanged.

The updater follows the configured public GitHub repository without embedding credentials. Windows is unsigned: SHA-512 verifies downloaded bytes against GitHub metadata, not an independent publisher identity. Native code signing remains a future task. Mac automatic installation stays disabled. Linux tar.gz remains a manual alternative. The private publishing token is never shipped to clients.

All packaging scripts use `--publish never`. The release-candidate workflow has only `contents: read` and uploads Actions artifacts for review. It builds pinned Showdex on Windows, then native Windows, Apple Silicon, Intel Mac, and Linux x64 packages. Generated Windows and Linux manifests (`latest.yml`, `latest-linux.yml`) and the Windows blockmap must accompany their corresponding binaries. Do not rename an update binary without regenerating metadata. Upload every binary first and metadata last, preferably to a draft release for future versions. Keep each future version increasing. The owner reports no current 0.2.0 users and requested a replacement candidate; replacing that tag/files requires explicit approval of the exact release text and file list. Never publish from a source push automatically.

Tests cover automatic download without quit hooks, cancellation, duplicate requests, state changes during confirmation, practice/search/battle/draft blocking, retries, and manual builds. The Electron suite uses a loopback feed and the real updater to check a newer download, corrupt SHA-512 rejection, same/older versions, and actual launcher IPC/UI guards. Its payload is inert and is never executed. This does not claim a clean-machine installer upgrade or Mac signing test.

## Home design exploration (November 19, 2026)

The owner requested a new UI direction with more color, personality, and slightly
rounded edges, inspired by the Pokémon TCG apps. Branch `feat/home-ui-rehaul`
contains the reviewable Home concept in `mockups/home-rehaul.html`. This is an
interactive design fragment, separate from the running launcher. It does not
change other pages, settings, accounts, matchmaking, or packaged assets.

The concept takes the light, tactile direction of
[Pokémon TCG Pocket](https://tcgpocket.pokemon.com/en-us/): pearl surfaces, aqua
battle controls, a warm yellow Battle button, a peach Daily Foul Play panel, and
Pokémon artwork. Rounded corners and subtle depth are intentional explorations
beyond the previous flat design rules. The existing navigation and Home tasks
remain recognizable. Dark mode uses deep blue with aqua and warm accents.

The format selector demonstrates OU with a clearly labeled sample team and
Random Battle with six unknown Pokémon. Battle/Cancel demonstrate a local
search state; other actions explain their destination without connecting to
Showdown. Appearance can be toggled in the preview. The inline design controls
also expose accent color, panel radius, and artwork visibility. No ratings,
online counts, or progress are fabricated as live data.

The owner logo is referenced from this repository at `c961530`. Pokémon artwork
is referenced from the [PokeAPI sprite archive](https://github.com/PokeAPI/sprites)
through jsDelivr, under `sprites/pokemon/other/official-artwork/`. Pokémon artwork
belongs to its respective owners. These references are preview assets, not a
new shipping asset dependency. The visualization host supplies Lucide icons.

Review evidence: `npm run check` passed, the inline script parsed, and Electron
rendered all nine images and 24 icons. Light/dark desktop and compact/mobile
captures were inspected. Layout checks found no horizontal overflow or
offscreen controls at desktop, minimum-window, and narrow preview widths.
Format changes, search/cancel, and appearance switching passed interaction
checks. The smaller window scrolls vertically. Generated standalone preview
and captures are under ignored `out/mockups/`. This is design review, not
verification of a production Home implementation.
