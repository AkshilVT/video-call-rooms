---
name: video-call-rooms
description: Lightweight peer-to-peer video meeting rooms (audio, video, screen share, chat, room codes). Start/stop the local server, publish an HTTPS invite link, create or end meetings.
approve: [ctl.py]
---
# Rooms

The page (`index.html`) is the host console. `server.py` is a resident process
it starts in the background (not callable through `/api/run`); guests open the
served pages in a browser. State lives in `.fused/data/` (settings, saved room
codes, server/tunnel pids); logs in `.fused/cache/logs/`.

## ctl.py
Controls the server, the public tunnel and the meetings. Writes `.fused/data/`.
Every action returns the full status object (`ok`, `server`, `tunnel`,
`publicUrl`, `settings`, `error` on failure).
- Args: `action` (str, default "status") — one of `status`, `start`, `stop`,
  `restart`, `tunnel_start`, `tunnel_stop`, `new_room`, `close_room`,
  `save_settings`, `open`, `logs`
- `label` (str, default "") — meeting name for `new_room`
- `code` (str, default "") — custom code for `new_room`; the code to end for `close_room`
- `url` (str, default "") — URL to open in the default browser for `open` (must belong to this server)
- `settings_json` (str, default "") — JSON object for `save_settings` (keys: serverName, port, maxPeers, allowCreate, camera, shareFps, customPublicUrl, autoTunnel, lan, turn{urls,username,credential})
- `which` (str, default "server") — log to tail for `logs`: `server`, `tunnel`, `stdout`
- `lines` (int, default 80) — lines to tail
- Returns: `{"ok": bool, "server": {"running": bool, "port": int, "localUrl": str, "rooms": [...]}, "tunnel": {"running": bool, "url": str}, "publicUrl": str, "settings": {...}, "room"?: {...}, "error"?: str}`
- Example: `{"action":"py","app":"video-call-rooms","file":"ctl.py","args":{"action":"new_room","label":"Daily standup"}}`
