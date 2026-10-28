# Rooms — lightweight Google Meet replacement

Inherits `~/.claude/design-principles.md`.

## Goal
Small-team video calls (2–8 people) with audio, video, screen share, chat and
Meet-style room codes, using a fraction of Meet's CPU/RAM. Host runs it from
this fused-render app; colleagues join from any desktop browser via one link.

## Why it is lighter than Meet
- Peer-to-peer WebRTC mesh: media never transits a server, no SFU, no simulcast
  (one encode per peer at modest resolution instead of 3 layers at 720p).
- Hardware codec first: H.264 preferred in SDP → VideoToolbox encode/decode on
  Macs (VP8/VP9 software encode is Meet's big CPU cost).
- 360p @ 24 fps default camera, 10 fps screen share, auto-downscale when the
  call grows, remote video paused when the tab is hidden or in audio-only mode.
- Zero frameworks: one HTML + one CSS + one JS file, no polling loops, no
  effects/blur/captions/ML.

## Data model
- `Room{code, label, created, saved, peers{}, chat[]}` — in server memory;
  saved rooms persisted to `.fused/data/rooms.json` so codes survive restarts.
- `Peer{id, name, state{mic,cam,screen,hand}, conn}` — one WebSocket.
- Server stores nothing else. Chat is in-memory (last 100 msgs for late joiners).
- Host console state: `.fused/data/settings.json`, `server.json` (pid, port,
  admin token), `tunnel.json` (cloudflared pid + public URL).

## Components
1. `server.py` — stdlib-only HTTP/1.1 + WebSocket signaling + static files.
   Public routes: `/`, `/r/<code>`, `/ws`, `/api/config`, `/api/rooms`.
   Admin routes (token): `/api/status`, `/api/admin/*`.
2. `www/` — guest-facing client: landing (new meeting / enter code), lobby
   (preview, devices, name), call (grid / stage + filmstrip, chat + people
   panel, bottom bar), left screen.
3. `ctl.py` — `fused.runPython` entry: start/stop server, Cloudflare quick
   tunnel for a public HTTPS link, create/close rooms, settings, open URL.
4. `index.html` — host console (this page): status, public link, meetings
   table with live participants, settings, logs.

## Vocabulary
"Meeting" (a room with a code), "Join", "Leave", "Present" (screen share),
"Public link" (tunnel URL), "Local link".

## Click behaviours
- Console: Start → server on 127.0.0.1:8765. Make public → cloudflared quick
  tunnel, shows https://….trycloudflare.com. New meeting → row with Copy link,
  Open (default browser), End. Stop → kills tunnel + server.
- Guest: open link → lobby (name, mic/cam toggles, device pickers) → Join now.
  In call: mic (⌘D), cam (⌘E), present, raise hand, chat, people, settings
  (devices, quality, share fps, audio-only), leave. Click a tile to pin.
- Presenter's screen takes the stage; others become a filmstrip.

## UI reference
Google Meet's in-call layout (dark stage, pill bottom bar, right-side chat
panel) — copied in spirit, simplified.

## Reachability
Guests need HTTPS for camera access. Default: Cloudflare quick tunnel (no
account, random URL per start). Optional: own reverse proxy / LAN self-signed
TLS. STUN via Google/Cloudflare public servers; TURN optional in settings.

## Out of scope (v1)
Recording, backgrounds/blur, captions, breakout rooms, dial-in, >12 people,
moderation beyond "End meeting", system-audio share.
