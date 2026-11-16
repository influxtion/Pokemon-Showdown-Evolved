# Practice API

Computes the practice bot's moves for Showdown Desktop. Only **Foul Play** is supported for now.

The battle itself always runs inside the desktop app, on its own private Showdown simulator. The app plays the bot's seat by streaming the bot's view of the battle to this API and sending back the move it returns. The same server runs in two places:

- **Cloud** (default in the app): a host you deploy from this folder.
- **This computer**: the app installs Foul Play with the same installer and runs this same server on `127.0.0.1`.

Only the machine doing the search differs, so the protocol, limits and validation are identical in both places.

```
Showdown Desktop (always local)                  Practice API (cloud or 127.0.0.1)
┌──────────────────────────────────┐            ┌────────────────────────────────────┐
│ practice client ──► simulator    │            │ HTTP: sessions, limits, API key    │
│                        ▲         │  frames →  │ WS /v1/sessions/:id/socket         │
│ bridge (logs in as FoulPlay,  ───┼───────────►│   └─ foulplay_worker.py, one per   │
│ accepts the challenge, relays) ◄─┼────────────│      session; no network access    │
└──────────────────────────────────┘  ← choices └────────────────────────────────────┘
```

## Run it

Requirements: Node 24, `tar`, internet access during setup and a C linker (`sudo apt install build-essential` on Debian/Ubuntu; Xcode command line tools on macOS). Python and Rust are not needed beforehand: setup downloads a pinned standalone Python and, if `cargo` is missing, a pinned private Rust toolchain that it removes after the build.

```sh
git clone https://github.com/influxtion/Pokemon-Showdown-Launcher-App.git
cd Pokemon-Showdown-Launcher-App/api
npm ci --omit=dev
npm run setup     # downloads and builds Foul Play into api/runtime (a few minutes)
npm start         # http://127.0.0.1:8787
```

`npm run status` reports what is installed. To update after pulling new pins, run `npm run setup` again and then restart. The new build goes to `runtime/staging` and replaces `runtime/current` only after its self-check passes.

Supported hosts: Linux x64/arm64, macOS x64/arm64 and Windows x64.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address. Use `0.0.0.0` only behind a proxy or in a container |
| `RUNTIME_DIR` | `api/runtime` | Where `npm run setup` installed Foul Play |
| `API_KEY` | unset | If set (32+ characters), every `/v1` request and socket needs `Authorization: Bearer <key>` |
| `TRUST_PROXY` | unset | `1` to rate-limit by the address in `X-Forwarded-For` (set only behind your own proxy) |
| `MAX_SESSIONS` | half the CPUs, at least 1 | Concurrent battles across the server |
| `MAX_THREADS` | `2` | Search threads per battle; caps the app's Quiet/Balanced/Full (1/2/8) |
| `MAX_SESSIONS_PER_CLIENT` | `1` | Concurrent battles per client network |
| `SESSIONS_PER_HOUR`, `SESSION_BURST` | `30`, `6` | Token bucket for starting battles, per client network |

CPU use is roughly `MAX_SESSIONS × MAX_THREADS` cores while every battle is thinking. A decision takes about 200 ms of search.

### Rate limits

Access is anonymous by default, so limits are per **client network**: an IPv4 address, or an IPv6 /64.

| Limit | Default | When exceeded |
| --- | --- | --- |
| Starting battles | Bursts of 6, refilling at 30 per hour | `429 rate-limited` with `Retry-After` |
| Concurrent battles per client network | 1 | `429 too-many-sessions` |
| Concurrent battles on the server | `MAX_SESSIONS` | `503 at-capacity` with `Retry-After: 30` |
| Frames per socket | Bursts of 200, refilling at 40 per second | Socket closed (`rate-limited`) |
| Frame size | 256 KiB | Socket closed |
| Moves per session | 5,000 | Socket closed (`decision-limit`) |
| Session lifetime, idle time, time to connect | 2 h, 15 min, 1 min | Session ended |

A single battle needs one session; rematches reuse it. The app's own local server sets these limits much higher.

## Deploy

**Docker Compose with automatic HTTPS (Caddy):**

```sh
cd api/deploy
API_DOMAIN=practice.example.org docker compose up -d --build
```

Point DNS at the host and open only ports 80 and 443. The compose file sets `TRUST_PROXY=1`, runs read-only without capabilities, and passes `MAX_*` variables through. Caddy keeps no access log, because session IDs in paths are capabilities.

**Without Docker:** follow [Run it](#run-it) as a dedicated user, put a TLS reverse proxy in front, and use `deploy/practice-api.service` as a systemd unit.

**Pointing the app at it:** set `CLOUD_API_URL` in `app/practice-engines.js` for release builds, or `SHOWDOWN_PRACTICE_API_URL=https://practice.example.org` when testing (plus `SHOWDOWN_PRACTICE_API_KEY` if you set `API_KEY`). The app accepts only HTTPS, or HTTP to `127.0.0.1`/`localhost`.

## Protocol

All responses are JSON. Errors look like `{"error": {"code": "rate-limited", "message": "…"}}`.

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no auth |
| `GET /v1/info` | API version, bots and their presets (after `MAX_THREADS`), limits, current capacity |
| `POST /v1/sessions` | Body `{"bot": "foulplay", "preset": "quiet" \| "balanced" \| "full"}` → `201 {id, threads, expiresAt, socket, …}` |
| `GET /v1/sessions/:id` | State, battles and decisions so far |
| `DELETE /v1/sessions/:id` | End the session and its worker |
| `WS /v1/sessions/:id/socket` | One socket per session. Requests with an `Origin` header (browsers) are refused |

The session ID is 256 random bits and acts as the capability for that session.

**Client → server:** `{"type": "frame", "data": ">battle-gen9randombattle-1\n|init|battle\n…"}`. `data` is one simulator frame for the bot's battle room, exactly as the simulator sent it to the bot. Anything else closes the socket.

**Server → client:**

| Message | Fields | Meaning |
| --- | --- | --- |
| `ready` | `bot, threads, searchMs` | The engine is loaded. Also sent on connect if it loaded first |
| `battle` | `room` | Foul Play saw `\|init\|battle` and is playing this room |
| `thinking` | `room, turn` | A decision is due |
| `choice` | `room, turn, choice, rqid, elapsedMs` | Send `room\|choice\|rqid` to the simulator as the bot |
| `end` | `room, result` | `win`, `loss` or `tie`, from the bot's side |
| `error` | `code, message` | Fatal; the socket closes next |

`choice` is always `/choose move <id>`, optionally followed by ` terastallize`, or `/switch <1-6>`. Both the server and the client check this. A choice the simulator rejects ends the session; Foul Play never falls back to random play.

`client.js` is a ready-made Node client, and `protocol.js` holds the shared constants.

## Files

| File | Role |
| --- | --- |
| `server.js` | HTTP and WebSocket server, sessions, limits, worker supervision |
| `client.js`, `protocol.js` | Node client used by the app; shared validation |
| `install.js`, `lock.json` | Pinned, hash-checked installer (also used by the app's Install button) |
| `worker/foulplay_worker.py` | Runs Foul Play's battle loop over stdio, with a loopback-only socket audit hook |
| `deploy/` | Dockerfile, Compose file, Caddyfile and systemd unit |
| `test/` | `npm test`: server and client tests with a fake worker |

## Licensing

This folder follows the repository's license, which has not been chosen yet. [Foul Play](https://github.com/pmariglia/foul-play) (pinned `8f541f8`) is GPL-3.0 and is downloaded by `npm run setup`; it is never committed or bundled with the app. Random battle set data comes from [`pkmn/randbats`](https://github.com/pkmn/randbats).
