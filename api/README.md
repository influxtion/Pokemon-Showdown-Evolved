# Practice API

Computes the practice bot's moves for Showdown Desktop. Only **Foul Play** is supported for now.

The battle itself always runs inside the desktop app, on its own private Showdown simulator. The app plays the bot's seat by streaming the bot's view of the battle to this API and sending back the move it returns. The app uses it only as a cloud server, a host you deploy from this folder ([Host it on a server](#host-it-on-a-server)); Foul Play never runs inside the app. Tests run the same server on `127.0.0.1` as a stand-in.

```
Showdown Desktop (always local)                  Practice API (cloud)            
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

A single battle needs one session; rematches reuse it.

## Host it on a server

This is how the app's default cloud server runs: an Ubuntu VM, the API as a systemd service on `127.0.0.1:8787`, and Caddy in front for HTTPS. Only ports 80 and 443 face the internet.

```
player's app ──HTTPS/WSS──► Caddy :443 ──► 127.0.0.1:8787 practice API ──► one Foul Play worker per battle
```

The steps assume Ubuntu or Debian and a user with `sudo`. Commands marked **(VM)** run on the server.

### 1. Get a machine, an address and a name

- **CPU:** each battle searches with up to `MAX_THREADS` cores (default 2). `MAX_SESSIONS` (default half the vCPUs) caps battles at once. With the defaults, a 16-vCPU VM serves 8 battles and is fully busy only when all 8 are thinking.
- **Address:** a public IPv4 address that does not change. On a cloud provider, reserve it as static.
- **Firewall:** allow inbound TCP 80 and 443. Port 80 is needed for the certificate. Keep 8787 closed.
- **Name:** HTTPS needs a hostname. Either point an `A` record of your own domain at the IP, or use [sslip.io](https://sslip.io) without a domain: the IP `203.0.113.7` becomes `203-0-113-7.sslip.io`. An sslip.io name changes if the IP changes, so the IP must be static.

On Google Cloud, see [Google Cloud notes](#google-cloud-notes) for each of these.

### 2. Install Node 24, a C toolchain and Caddy (VM)

```sh
sudo apt update
sudo apt install -y git curl build-essential debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy (official repository)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

node --version && caddy version
```

Any way of installing Node 24 works (nvm, for example), as long as `command -v node` finds it in the shell you use for step 4.

### 3. Clone and install Foul Play (VM)

```sh
cd ~
git clone https://github.com/influxtion/Pokemon-Showdown-Launcher-App.git
cd Pokemon-Showdown-Launcher-App/api
npm ci --omit=dev
npm run setup      # a few minutes; ends with the worker's self-check
npm run status
```

### 4. Run the API as a service (VM)

This unit runs the API as your own user from the clone in your home folder, starts it at boot and restarts it if it crashes. Paste it as one block from the same folder as step 3. The `<<EOF` heredoc fills in your user, Node path and folder.

```sh
NODE="$(command -v node)"
API_DIR="$HOME/Pokemon-Showdown-Launcher-App/api"
echo "node: $NODE   api: $API_DIR"   # both must be non-empty

sudo tee /etc/systemd/system/practice-api.service >/dev/null <<EOF
[Unit]
Description=Showdown Desktop practice API
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$API_DIR
ExecStart=$NODE server.js
Environment=HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 MAX_THREADS=2
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now practice-api
sleep 2; curl -s http://127.0.0.1:8787/healthz; echo     # {"ok":true}
```

Stop any copy you started by hand with `npm start` first, or the service cannot take port 8787. Other limits from [Configuration](#configuration) go on the `Environment=` line.

For a locked-down setup with a dedicated `practice-api` user and the clone in `/opt/showdown-desktop`, adapt `deploy/practice-api.service` instead. That template is untested.

### 5. Put HTTPS in front with Caddy (VM)

```sh
API_HOST=203-0-113-7.sslip.io     # your sslip.io name or your own domain

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$API_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8787
	log {
		output discard
	}
}
EOF
sudo systemctl reload caddy
curl -s "https://$API_HOST/healthz"; echo      # {"ok":true}
```

The first HTTPS request can take about 20 seconds while Caddy gets the certificate, and Caddy renews it on its own. Keep access logs off: session IDs in request paths are capabilities. `TRUST_PROXY=1` from step 4 makes rate limits use the client address that Caddy passes on. Never set it on a server that is reachable without the proxy.

### 6. Check it end to end

`/v1/info` shows the bot, the presets after the thread cap, and current capacity:

```sh
curl -s https://203-0-113-7.sslip.io/v1/info; echo
```

From a development checkout of the app with the simulator built (`npm run bots:setup`, see [bots.md](../docs/bots.md#development-setup)), play two real battles against the server:

```sh
node tests/practice-api-live.cjs --url https://203-0-113-7.sslip.io
```

### 7. Point the app at it

Set `CLOUD_API_URL` in `app/practice-engines.js`. Release builds use it as the **Cloud** option. To try a server without changing code, start a development build with `SHOWDOWN_PRACTICE_API_URL=https://…`, plus `SHOWDOWN_PRACTICE_API_KEY` if the server has an `API_KEY`. Release builds carry no key, so the default cloud server has to accept anonymous access. The app accepts only HTTPS, or HTTP to `127.0.0.1`/`localhost`.

### Running it day to day (VM)

| Task | Command |
| --- | --- |
| Update after new commits or pins | `cd ~/Pokemon-Showdown-Launcher-App && git pull && cd api && npm ci --omit=dev && npm run setup && sudo systemctl restart practice-api` |
| Follow the logs | `journalctl -u practice-api -f` (Caddy: `journalctl -u caddy -f`) |
| Status | `systemctl status practice-api caddy --no-pager` and `npm run status` |
| Change limits | `sudo systemctl edit practice-api`, add `[Service]` and `Environment=MAX_SESSIONS=4`, then `sudo systemctl restart practice-api` |

A restart ends the battles in progress. Players see the cloud as unreachable and can start again once it is back.

### Google Cloud notes

These are the snags hit while deploying the default server on a Compute Engine VM.

- **Run `gcloud` from Cloud Shell, not from the VM.** On the VM, `gcloud compute …` fails with *Request had insufficient authentication scopes*, because the VM's service account has no Compute permissions. Cloud Shell (`>_` at the top right of the console) runs as you.
- **Reserve the IP and open the ports** (Cloud Shell; replace the VM name and zone):

  ```sh
  VM=ob-worker ZONE=us-south1-b REGION=us-south1
  gcloud compute addresses create practice-api-ip --region "$REGION" \
    --addresses "$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
  gcloud compute instances add-tags "$VM" --zone "$ZONE" --tags http-server,https-server
  NET="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].network.basename())')"
  gcloud compute firewall-rules describe default-allow-http  >/dev/null 2>&1 || gcloud compute firewall-rules create default-allow-http  --network "$NET" --allow tcp:80  --target-tags http-server
  gcloud compute firewall-rules describe default-allow-https >/dev/null 2>&1 || gcloud compute firewall-rules create default-allow-https --network "$NET" --allow tcp:443 --target-tags https-server
  ```

  Adding the tags alone opens nothing; the two firewall rules do. In the console, the same steps are **VPC network → IP addresses → Promote to static** and the VM's **Edit → Allow HTTP/HTTPS traffic**.
- **`sudo` says *I'm sorry … I'm afraid I can't do that*.** If your username on the VM is your plain name, as here, the VM uses SSH keys from metadata, not OS Login. The browser **SSH** button's sudo access stopped working partway through a session. Connecting from Cloud Shell with `gcloud compute ssh VM --zone ZONE` kept it. If the project uses OS Login instead (usernames like `you_gmail_com`), sudo needs the **Compute OS Admin Login** role and a new SSH session.
- **`apt update` fails with 404 from `*.gce.clouds.archive.ubuntu.com`.** If the regional Ubuntu mirror lacks your release, switch to the main archive:

  ```sh
  sudo grep -rl 'gce.clouds.archive.ubuntu.com' /etc/apt/ \
    | xargs -r sudo sed -i 's|http://[a-z0-9-]*\.gce\.clouds\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g'
  sudo apt update
  ```

### With Docker instead

```sh
cd api/deploy
API_DOMAIN=practice.example.org docker compose up -d --build
```

This replaces steps 2 to 5. Point DNS at the host and open only ports 80 and 443. The compose file runs the API and Caddy, sets `TRUST_PROXY=1`, runs the API read-only without capabilities, and passes the `MAX_*` and `API_KEY` variables through. The image build is untested.

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
| `install.js`, `lock.json` | Pinned, hash-checked installer (`npm run setup`) |
| `worker/foulplay_worker.py` | Runs Foul Play's battle loop over stdio, with a loopback-only socket audit hook |
| `deploy/` | Dockerfile, Compose file, Caddyfile and systemd unit |
| `test/` | `npm test`: server and client tests with a fake worker |

## Licensing

This folder follows the repository's license, which has not been chosen yet. [Foul Play](https://github.com/pmariglia/foul-play) (pinned `8f541f8`) is GPL-3.0 and is downloaded by `npm run setup`; it is never committed or bundled with the app. Random battle set data comes from [`pkmn/randbats`](https://github.com/pkmn/randbats).
