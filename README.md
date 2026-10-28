# Rooms — a lightweight Google Meet replacement

Audio, video, screen share, chat and Meet-style room codes for small teams,
at a fraction of Meet's CPU and memory. Runs from your Mac; colleagues join
from any desktop browser with one link. Media is peer-to-peer and never
touches a server.

## Use it

1. Open this app in fused-render and press **Start server**.
2. Press **Make public**. You get an `https://….trycloudflare.com` link
   (Cloudflare quick tunnel, no account; needs `brew install cloudflared`).
3. Press **New meeting**, give it a name. The link is copied; send it to your
   team. Saved meetings keep their code across restarts, so a "Daily standup"
   link can live in your calendar.
4. Join yourself with **Open**. Guests land in a lobby (name, mic/cam check),
   then the call.

In the call: mic (⌘D), camera (⌘E), present screen, raise hand, chat, people,
settings (devices, quality, audio-only, stats), leave. Click a tile to pin it.
A presenter's screen takes the stage; everyone else becomes a filmstrip.

## Why it's lighter than Meet

- **Peer-to-peer mesh**: no SFU, no simulcast. Each person sends one modest
  stream per peer instead of three layers.
- **Hardware codec first**: H.264 is preferred in the SDP so Macs (and most
  laptops) encode/decode in hardware. VP8/VP9 software encode is where Meet
  spends most of its CPU.
- **Sane defaults**: 360p @ 24 fps camera, 10 fps screen share. Video scales
  down automatically as the call grows (5–6 people: 1.5×, 7+: 2×) and stops
  being sent to anyone whose tab is hidden or in audio-only mode.
- **No app weight**: one HTML, one CSS, one JS file. No framework, no
  background blur, no captions, no telemetry.

Mesh means every extra participant costs everyone a bit more upload and CPU.
It is tuned for 2–8 people (the cap is configurable up to 16; past ~8 a real
SFU is the right tool).

## Reachability

Browsers only allow camera and microphone on HTTPS (or localhost), so guests
need an HTTPS link:

| Option | How | Notes |
|---|---|---|
| Cloudflare quick tunnel (default) | **Make public** | Zero config, random URL per start, public but unguessable. |
| Own HTTPS reverse proxy | Settings → Public URL | Tailscale Serve, Caddy, nginx, or a named Cloudflare tunnel in front of `http://127.0.0.1:8765`. Stable URL. |
| LAN mode | Settings → LAN mode | Binds all interfaces with a self-signed certificate; colleagues on the same network click through a browser warning once. |

NAT traversal uses public STUN (Google, Cloudflare). If two people are both
behind symmetric NAT they need a TURN relay: enter one under Settings.

## Files

| File | Role |
|---|---|
| `index.html` | Host console (this fused-render page): status, invite link, meetings, settings, logs. |
| `ctl.py` | Called by the console via `fused.runPython`: starts/stops `server.py`, runs `cloudflared`, creates/ends rooms, saves settings. |
| `server.py` | Stdlib-only Python server: static files + WebSocket signaling + chat + JSON API. No dependencies. |
| `www/` | Guest client: `index.html` (landing), `room.html` + `room.js` (lobby + call), `app.css`. |
| `tests/e2e.mjs` | Playwright end-to-end: 3 fake-media Chromium peers, Firefox interop, WebKit smoke. `cd tests && npm i && node e2e.mjs --firefox --webkit`. |
| `tests/console.mjs` | Drives the host console inside fused-render. |
| `tests/edge.mjs` | 6-person mesh and auto-downscale, audio-only pausing, creation disabled, room full, lost-offer recovery. |
| `tests/protocol.mjs` | Raw-socket server tests: simultaneous-join ordering, fragment floods, request smuggling, reconnect tokens. |
| `tests/tunnel.mjs` | Opens a real Cloudflare quick tunnel and joins through it (run by hand; publishes a temporary URL). |

State: `.fused/data/settings.json`, `rooms.json` (saved codes), `server.json`
(pid, port, admin token), `tunnel.json`. Logs: `.fused/cache/logs/`.

## Security notes

- Rooms are protected by their code (10 random letters). The landing page can
  create rooms unless you turn that off in Settings.
- Reconnecting under an existing participant id requires the resume token that
  participant received, so nobody can evict someone else by replaying their id.
- Admin endpoints (`/api/status`, `/api/admin/*`) need the random token in
  `server.json` and are refused through the tunnel.
- Chat is kept in memory for late joiners (last 100 messages) and dropped when
  a room sits empty for an hour. Nothing is written to disk except settings
  and saved room codes.
- The server sets a strict Content-Security-Policy, denies framing and checks
  WebSocket origins.

## Run the server by hand

```
python3 server.py --port 8765 --data .fused/data
ROOMS_ADMIN_TOKEN=secret python3 server.py --port 8765   # enables /api/status
cloudflared tunnel --url http://127.0.0.1:8765           # public HTTPS link
```
