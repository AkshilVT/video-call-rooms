#!/usr/bin/env python3
"""Rooms signaling server (see design.md).

Standard library only, Python 3.9+. One process serves:
  * the guest client from ./www  (landing, lobby, call)
  * a WebSocket endpoint /ws that relays SDP/ICE, presence, state and chat
  * a small JSON API: public (/api/config, /api/rooms/<code>) and admin
    (/api/status, /api/admin/*, guarded by a random token)

Media never touches this process: WebRTC is peer-to-peer. The process is
tiny on purpose: a few threads, a dict of rooms, no dependencies.

Run:  python3 server.py --port 8765 --data .fused/data --log .fused/cache/logs/server.log
Env:  ROOMS_ADMIN_TOKEN  admin token (preferred over --token: not visible in ps)
"""
import argparse
import base64
import hashlib
import hmac
import json
import logging
import logging.handlers
import mimetypes
import os
import queue
import re
import secrets
import signal
import socket
import ssl
import struct
import sys
import tempfile
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "0.2.0"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_FRAME = 96 * 1024           # one WebSocket frame
MAX_MESSAGE = 96 * 1024         # reassembled message (an SDP is ~10-30 KB)
MAX_FRAGMENTS = 64              # fragments per message
MAX_BODY = 64 * 1024            # JSON API bodies
MAX_NAME = 40
MAX_CHAT = 2000
CHAT_HISTORY = 100
SEND_QUEUE = 512                # frames buffered per connection before it is dropped
JOIN_TIMEOUT = 15               # seconds a fresh socket gets to send its join
WS_IDLE_TIMEOUT = 75            # client pings every 20 s; silence this long = dead
ROOM_PRUNE_AFTER = 60 * 60      # unsaved empty rooms vanish after an hour
CODE_ALPHABET = "bcdfghjkmnpqrstvwxz"   # no vowels: no accidental words
CODE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,16}$")
LOCAL_ORIGIN_RE = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")

log = logging.getLogger("rooms")

DEFAULT_SETTINGS = {
    "port": 8765,
    "bind": "127.0.0.1",
    "maxPeers": 8,
    "allowCreate": True,
    "serverName": "Rooms",
    "camera": "medium",      # low | medium | high
    "shareFps": 10,
    "stun": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    "turn": {"urls": "", "username": "", "credential": ""},
    "lan": False,            # bind 0.0.0.0 + self-signed TLS (set up by ctl.py)
    "autoTunnel": False,
}


# ----------------------------------------------------------------------------
# settings / persistence helpers
# ----------------------------------------------------------------------------

def atomic_write(path, text, mode=0o644):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_settings(data_dir):
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    if data_dir:
        on_disk = read_json(os.path.join(data_dir, "settings.json"), {})
        if isinstance(on_disk, dict):
            for k, v in on_disk.items():
                if k in merged and v is not None:
                    merged[k] = v
    # sanitise everything the client or ice_servers() will touch
    try:
        merged["maxPeers"] = max(2, min(16, int(merged["maxPeers"])))
    except (TypeError, ValueError):
        merged["maxPeers"] = DEFAULT_SETTINGS["maxPeers"]
    try:
        merged["shareFps"] = max(1, min(30, int(merged["shareFps"])))
    except (TypeError, ValueError):
        merged["shareFps"] = DEFAULT_SETTINGS["shareFps"]
    if merged["camera"] not in ("low", "medium", "high"):
        merged["camera"] = "medium"
    merged["allowCreate"] = bool(merged["allowCreate"])
    merged["serverName"] = str(merged.get("serverName") or "Rooms")[:60]
    stun = merged.get("stun")
    if isinstance(stun, str):
        stun = re.split(r"[,\s]+", stun)
    merged["stun"] = [s for s in (stun if isinstance(stun, list) else []) if isinstance(s, str)]
    turn = merged.get("turn")
    merged["turn"] = turn if isinstance(turn, dict) else dict(DEFAULT_SETTINGS["turn"])
    return merged


def ice_servers(settings):
    out = []
    stun = [s for s in (settings.get("stun") or []) if isinstance(s, str) and s.startswith("stun:")]
    if stun:
        out.append({"urls": stun})
    turn = settings.get("turn")
    if not isinstance(turn, dict):
        turn = {}
    urls = turn.get("urls") or ""
    if isinstance(urls, str):
        urls = [u.strip() for u in re.split(r"[,\s]+", urls) if u.strip()]
    if not isinstance(urls, list):
        urls = []
    urls = [u for u in urls if isinstance(u, str) and u.startswith(("turn:", "turns:"))]
    user, cred = turn.get("username"), turn.get("credential")
    # a TURN entry without credentials makes `new RTCPeerConnection` throw in every browser
    if urls and user and cred:
        out.append({"urls": urls, "username": str(user), "credential": str(cred)})
    return out


def new_code():
    def chunk(n):
        return "".join(secrets.choice(CODE_ALPHABET) for _ in range(n))
    return "%s-%s-%s" % (chunk(3), chunk(4), chunk(3))


def clean_name(raw):
    s = re.sub(r"\s+", " ", str(raw or "")).strip()
    return s[:MAX_NAME] or "Guest"


def clean_state(raw):
    raw = raw if isinstance(raw, dict) else {}
    return {k: bool(raw.get(k, False)) for k in ("mic", "cam", "screen", "hand")}


def same_secret(a, b):
    try:
        return hmac.compare_digest(str(a or "").encode("utf-8", "replace"), str(b or "").encode("utf-8", "replace"))
    except (TypeError, ValueError):
        return False


# ----------------------------------------------------------------------------
# WebSocket (RFC 6455, server side, text frames)
# ----------------------------------------------------------------------------

class WSError(Exception):
    pass


class WSClosed(Exception):
    pass


def ws_unmask(payload, mask):
    n = len(payload)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


class WSConn:
    """One WebSocket. Reads happen on the handler thread; writes go through a
    bounded queue drained by a writer thread, so one stalled peer can never
    block a broadcast to the others."""

    def __init__(self, sock, rfile, wfile, addr):
        self.sock = sock
        self.rfile = rfile
        self.wfile = wfile
        self.addr = addr
        self.closed = False
        self.last_rx = time.time()
        self.q = queue.Queue(maxsize=SEND_QUEUE)
        self.writer = threading.Thread(target=self._writer, name="ws-writer", daemon=True)
        self.writer.start()

    # -- writing -----------------------------------------------------------
    def _writer(self):
        while True:
            item = self.q.get()
            if item is None:
                return
            try:
                self.wfile.write(item)
                self.wfile.flush()
            except (OSError, ValueError):
                self.closed = True
                self._shutdown()
                return

    def send_frame(self, opcode, payload=b""):
        if self.closed:
            return False
        n = len(payload)
        if n < 126:
            header = bytes((0x80 | opcode, n))
        elif n < 65536:
            header = bytes((0x80 | opcode, 126)) + struct.pack("!H", n)
        else:
            header = bytes((0x80 | opcode, 127)) + struct.pack("!Q", n)
        try:
            self.q.put_nowait(header + payload)
            return True
        except queue.Full:
            log.info("ws %s: send queue full, dropping connection", self.addr[0])
            self.closed = True
            self._shutdown()
            return False

    def send_json(self, obj):
        return self.send_frame(0x1, json.dumps(obj, separators=(",", ":")).encode("utf-8"))

    def _shutdown(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)   # unblocks a reader in another thread
        except OSError:
            pass

    def close(self, code=1000, reason=""):
        if self.closed:
            return
        self.send_frame(0x8, struct.pack("!H", code) + reason.encode("utf-8")[:120])
        self.closed = True
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass
        if threading.current_thread() is not self.writer:
            self.writer.join(1.0)            # let the close frame leave the building
        self._shutdown()

    # -- reading -----------------------------------------------------------
    def _read_exact(self, n):
        buf = self.rfile.read(n)
        if buf is None or len(buf) < n:
            raise WSClosed()
        return buf

    def recv(self):
        """Block for one complete data message; answers pings in between."""
        fragments = []
        op = None
        total = 0
        while True:
            h = self._read_exact(2)
            b1, b2 = h[0], h[1]
            fin, rsv, opcode = b1 & 0x80, b1 & 0x70, b1 & 0x0F
            masked, length = b2 & 0x80, b2 & 0x7F
            if rsv:
                raise WSError("reserved bits set")
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            if not masked:
                raise WSError("unmasked client frame")
            if length > MAX_FRAME:
                self.close(1009, "frame too large")
                raise WSError("frame too large")
            mask = self._read_exact(4)
            payload = self._read_exact(length) if length else b""
            if length:
                payload = ws_unmask(payload, mask)
            self.last_rx = time.time()
            if opcode >= 0x8:                      # control frame
                if not fin or length > 125:
                    raise WSError("bad control frame")
                if opcode == 0x8:
                    self.close(1000, "")
                    raise WSClosed()
                if opcode == 0x9:
                    self.send_frame(0xA, payload)
                continue
            if opcode == 0x0:
                if op is None:
                    raise WSError("continuation without start")
            else:
                if op is not None:
                    raise WSError("interleaved data frames")
                op = opcode
            fragments.append(payload)
            total += length
            if total > MAX_MESSAGE or len(fragments) > MAX_FRAGMENTS:
                self.close(1009, "message too large")
                raise WSError("message too large")
            if fin:
                return op, b"".join(fragments)


# ----------------------------------------------------------------------------
# rooms
# ----------------------------------------------------------------------------

class RoomFull(Exception):
    pass


class RoomClosed(Exception):
    pass


class Peer:
    __slots__ = ("id", "name", "state", "conn", "joined", "chat_times", "token")

    def __init__(self, pid, name, state, conn, token):
        self.id = pid
        self.name = name
        self.state = state
        self.conn = conn
        self.joined = time.time()
        self.chat_times = deque(maxlen=10)
        self.token = token        # resume secret: proves a reconnect owns this id

    def public(self):
        return {"id": self.id, "name": self.name, "state": self.state, "joined": int(self.joined * 1000)}


class Room:
    def __init__(self, code, label="", created=None, saved=False):
        self.code = code
        self.label = label or ""
        self.created = created or time.time()
        self.saved = saved
        self.peers = {}
        self.chat = deque(maxlen=CHAT_HISTORY)
        self.lock = threading.RLock()
        self.join_lock = threading.Lock()   # serialises join -> welcome -> peer-joined
        self.empty_since = time.time()
        self.closed = False

    def public(self):
        return {"code": self.code, "label": self.label, "created": int(self.created * 1000), "saved": self.saved}

    def status(self):
        with self.lock:
            return dict(self.public(), peers=[p.public() for p in self.peers.values()], chat=len(self.chat))

    def join(self, conn, name, state, want_id, want_token, max_peers):
        replaced = None
        with self.lock:
            if self.closed:
                raise RoomClosed()
            existing = self.peers.get(want_id) if want_id else None
            if existing is not None and same_secret(existing.token, want_token):
                replaced = self.peers.pop(want_id)
                pid, token = want_id, replaced.token
            else:
                if len(self.peers) >= max_peers:
                    raise RoomFull()
                pid = None
                while not pid or pid in self.peers:
                    pid = secrets.token_urlsafe(6)
                token = secrets.token_urlsafe(16)
            peer = Peer(pid, name, state, conn, token)
            self.peers[pid] = peer
            self.empty_since = None
        if replaced is not None:
            replaced.conn.close(4000, "replaced by reconnect")
            self.broadcast({"type": "peer-left", "id": pid, "reason": "reconnect"}, exclude=peer)
        return peer

    def leave(self, peer):
        with self.lock:
            if self.peers.get(peer.id) is not peer:
                return False
            del self.peers[peer.id]
            if not self.peers:
                self.empty_since = time.time()
            return True

    def snapshot(self, exclude=None):
        with self.lock:
            return [p for p in self.peers.values() if p is not exclude]

    def broadcast(self, msg, exclude=None):
        data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        for p in self.snapshot(exclude):
            p.conn.send_frame(0x1, data)

    def find(self, pid):
        with self.lock:
            return self.peers.get(pid)

    def add_chat(self, entry):
        with self.lock:
            self.chat.append(entry)

    def history(self):
        with self.lock:
            return list(self.chat)

    def close(self):
        with self.lock:
            self.closed = True
            peers = list(self.peers.values())
            self.peers.clear()
            self.empty_since = time.time()
        for p in peers:
            p.conn.send_json({"type": "closed", "reason": "ended by host"})
            p.conn.close(1000, "room closed")


class Rooms:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.lock = threading.RLock()
        self.persist_lock = threading.Lock()
        self.rooms = {}
        self.path = os.path.join(data_dir, "rooms.json") if data_dir else None
        if self.path:
            for r in read_json(self.path, []) or []:
                try:
                    code = str(r["code"])
                    if CODE_RE.match(code):
                        self.rooms[code] = Room(code, str(r.get("label") or ""), float(r.get("created") or time.time()), True)
                except (KeyError, TypeError, ValueError):
                    continue

    def persist(self):
        if not self.path:
            return
        with self.persist_lock:
            with self.lock:
                saved = [{"code": r.code, "label": r.label, "created": r.created} for r in self.rooms.values() if r.saved]
            try:
                atomic_write(self.path, json.dumps(saved, indent=1))
            except OSError as e:
                log.warning("could not persist rooms: %s", e)

    def get(self, code):
        with self.lock:
            return self.rooms.get(code)

    def create(self, code=None, label="", saved=False):
        with self.lock:
            if code:
                room = self.rooms.get(code)
                if room:
                    if label:
                        room.label = label
                    if saved and not room.saved:
                        room.saved = True
                else:
                    room = Room(code, label, None, saved)
                    self.rooms[code] = room
            else:
                code = new_code()
                while code in self.rooms:
                    code = new_code()
                room = Room(code, label, None, saved)
                self.rooms[code] = room
        if saved:
            self.persist()
        return room

    def get_or_create(self, code, allow_create):
        room = self.get(code)
        if room or not allow_create or not CODE_RE.match(code):
            return room
        return self.create(code)

    def close(self, code):
        with self.lock:
            room = self.rooms.pop(code, None)
        if room:
            room.close()
            if room.saved:
                self.persist()
        return room is not None

    def set_saved(self, code, saved):
        room = self.get(code)
        if not room:
            return False
        room.saved = bool(saved)
        self.persist()
        return True

    def status(self):
        with self.lock:
            rooms = list(self.rooms.values())
        return sorted((r.status() for r in rooms), key=lambda r: (-len(r["peers"]), -r["created"]))

    def prune(self):
        now = time.time()
        with self.lock:
            for code, room in list(self.rooms.items()):
                with room.lock:
                    idle = room.empty_since is not None and now - room.empty_since > ROOM_PRUNE_AFTER
                    if idle and room.chat:
                        room.chat.clear()
                    if idle and not room.saved and not room.peers:
                        room.closed = True        # a session holding this Room retries get_or_create
                        del self.rooms[code]


# ----------------------------------------------------------------------------
# server state shared by handlers
# ----------------------------------------------------------------------------

class State:
    def __init__(self, args):
        self.args = args
        self.data_dir = args.data
        self.settings = load_settings(args.data)
        self.rooms = Rooms(args.data)
        self.token = args.token or os.environ.get("ROOMS_ADMIN_TOKEN") or ""
        self.public_url = (args.public_url or "").rstrip("/")
        self.started = time.time()
        self.port = args.port
        self.host = args.host
        self.tls = bool(args.tls_cert)
        self.www = os.path.abspath(args.www or os.path.join(ROOT, "www"))
        self.lock = threading.Lock()

    def reload_settings(self):
        with self.lock:
            self.settings = load_settings(self.data_dir)

    def public_config(self):
        s = self.settings
        return {
            "version": VERSION,
            "serverName": s["serverName"],
            "maxPeers": s["maxPeers"],
            "allowCreate": s["allowCreate"],
            "camera": s["camera"],
            "shareFps": s["shareFps"],
            "iceServers": ice_servers(s),
            "publicUrl": self.public_url,
        }

    def is_admin(self, handler, query):
        if not self.token:
            return False
        if handler.headers.get("CF-Connecting-IP"):      # never through the tunnel
            return False
        given = handler.headers.get("X-Admin-Token") or (query.get("token") or [""])[0]
        return bool(given) and same_secret(given, self.token)


STATE = None  # type: State


# ----------------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------------

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; "
       "connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'")

EXTRA_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml",
               ".webmanifest": "application/manifest+json", ".ico": "image/x-icon"}


class QuietAbort(Exception):
    """Raised to drop a connection without a traceback (bad TLS handshake etc.)."""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Rooms/" + VERSION
    sys_version = ""
    timeout = 30

    # -- plumbing ------------------------------------------------------------
    def setup(self):
        super().setup()
        if isinstance(self.connection, ssl.SSLSocket):
            try:
                self.connection.do_handshake()
            except (ssl.SSLError, OSError, socket.timeout) as e:
                raise QuietAbort("tls handshake failed: %s" % e)

    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def log_error(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def _origin_ok(self, origin):
        if not origin:
            return True
        host = self.headers.get("Host", "")
        try:
            o = urlparse(origin)
        except ValueError:
            return False
        if o.netloc and o.netloc == host:
            return True
        if STATE.public_url and o.netloc and o.netloc == urlparse(STATE.public_url).netloc:
            return True
        return False

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and LOCAL_ORIGIN_RE.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def send_bytes(self, code, body, ctype="text/plain; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self._cors()
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_bytes(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8",
                        {"Cache-Control": "no-store"})

    def fail(self, code, message, close=False):
        if close:
            self.close_connection = True       # body may be unread: never reuse this socket
        self.send_json({"ok": False, "error": message}, code)

    def read_body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("chunked bodies are not accepted")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        if n > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(n)
        if not raw.strip():
            return {}
        body = json.loads(raw.decode("utf-8"))
        return body if isinstance(body, dict) else {}

    # -- verbs ---------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        query = parse_qs(u.query)
        path = u.path
        if path == "/ws":
            return self.handle_ws(query)
        if path.startswith("/api/"):
            return self.api("GET", path, query, {})
        return self.static(path)

    def do_POST(self):
        u = urlparse(self.path)
        query = parse_qs(u.query)
        if not u.path.startswith("/api/"):
            return self.fail(404, "not found", close=True)
        try:
            body = self.read_body()
        except (ValueError, UnicodeDecodeError) as e:
            return self.fail(400, "bad body: %s" % e, close=True)
        return self.api("POST", u.path, query, body)

    # -- static files --------------------------------------------------------
    def static(self, path):
        if path == "/healthz":
            return self.send_bytes(200, b"ok")
        if path == "/":
            rel = "index.html"
        elif re.match(r"^/r/[A-Za-z0-9_-]{2,40}/?$", path):
            rel = "room.html"
        else:
            rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(STATE.www, rel))
        if not full.startswith(STATE.www + os.sep) or not os.path.isfile(full):
            return self.send_bytes(404, b"Not found")
        try:
            st = os.stat(full)
            etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self.send_bytes(404, b"Not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = EXTRA_TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "text/javascript":
            ctype += "; charset=utf-8"
        headers = {"Cache-Control": "no-cache", "ETag": etag}
        if ext == ".html":
            headers.update({
                "Content-Security-Policy": CSP,
                "Referrer-Policy": "no-referrer",
                "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)",
                "X-Frame-Options": "DENY",
            })
        self.send_bytes(200, body, ctype, headers)

    # -- JSON API ------------------------------------------------------------
    def api(self, method, path, query, body):
        st = STATE
        if path == "/api/config" and method == "GET":
            return self.send_json(st.public_config())
        if path == "/api/rooms" and method == "POST":
            if not (st.settings["allowCreate"] or st.is_admin(self, query)):
                return self.fail(403, "creating meetings is disabled on this server")
            room = st.rooms.create(label=clean_name(body.get("label", ""))[:MAX_NAME] if body.get("label") else "")
            log.info("room created %s", room.code)
            return self.send_json({"ok": True, "room": room.public()})
        m = re.match(r"^/api/rooms/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])$", path)
        if m and method == "GET":
            room = st.rooms.get(m.group(1))
            if not room:
                return self.send_json({"ok": True, "exists": False, "canCreate": st.settings["allowCreate"]})
            return self.send_json({"ok": True, "exists": True, "label": room.label,
                                   "count": len(room.snapshot()), "maxPeers": st.settings["maxPeers"]})
        # ---- admin -------------------------------------------------------
        is_admin_path = path == "/api/status" or path.startswith("/api/admin/")
        if not st.is_admin(self, query):
            return self.fail(401 if is_admin_path else 404, "admin token required" if is_admin_path else "not found")
        if path == "/api/status":
            return self.send_json({
                "ok": True, "version": VERSION, "pid": os.getpid(), "host": st.host, "port": st.port,
                "tls": st.tls, "started": int(st.started * 1000), "uptime": int(time.time() - st.started),
                "publicUrl": st.public_url, "settings": st.public_config(), "rooms": st.rooms.status(),
            })
        if method != "POST":
            return self.fail(405, "POST required")
        if path == "/api/admin/rooms":
            code = str(body.get("code") or "").strip().lower()
            if code and not CODE_RE.match(code):
                return self.fail(400, "code must be 3-40 chars: a-z, 0-9, dashes")
            room = st.rooms.create(code or None, clean_name(body.get("label", ""))[:MAX_NAME] if body.get("label") else "",
                                   saved=bool(body.get("save", True)))
            log.info("room created by host %s", room.code)
            return self.send_json({"ok": True, "room": room.public()})
        m = re.match(r"^/api/admin/rooms/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])/(close|save|unsave)$", path)
        if m:
            code, verb = m.group(1), m.group(2)
            if verb == "close":
                ok = st.rooms.close(code)
                log.info("room closed %s (%s)", code, "ok" if ok else "missing")
            else:
                ok = st.rooms.set_saved(code, verb == "save")
            return self.send_json({"ok": ok})
        if path == "/api/admin/public-url":
            url = str(body.get("url") or "").strip().rstrip("/")
            if url and not re.match(r"^https?://[A-Za-z0-9.-]+(:\d+)?$", url):
                return self.fail(400, "url must be an origin like https://host")
            st.public_url = url
            log.info("public url set to %r", url)
            return self.send_json({"ok": True, "publicUrl": url})
        if path == "/api/admin/reload":
            st.reload_settings()
            return self.send_json({"ok": True, "settings": st.public_config()})
        if path == "/api/admin/quit":
            self.send_json({"ok": True})
            threading.Thread(target=request_shutdown, daemon=True).start()
            return
        return self.fail(404, "not found")

    # -- WebSocket -----------------------------------------------------------
    def handle_ws(self, query):
        if self.headers.get("Upgrade", "").lower() != "websocket" or \
           "upgrade" not in self.headers.get("Connection", "").lower():
            return self.send_bytes(400, b"WebSocket upgrade expected")
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or self.headers.get("Sec-WebSocket-Version") != "13":
            return self.send_bytes(400, b"bad WebSocket handshake")
        if not self._origin_ok(self.headers.get("Origin")):
            log.info("ws rejected origin %r host %r", self.headers.get("Origin"), self.headers.get("Host"))
            return self.send_bytes(403, b"origin not allowed")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True
        conn = WSConn(self.connection, self.rfile, self.wfile, self.client_address)
        try:
            ws_session(conn)
        except (WSClosed, ConnectionError, socket.timeout, OSError):
            pass
        except WSError as e:
            log.info("ws protocol error from %s: %s", self.client_address[0], e)
        except Exception:                      # never take the thread down silently
            log.exception("ws session crashed")
        finally:
            conn.close()


def handle_error_quietly(server, request, client_address):
    """One log line per dropped connection instead of a traceback on stderr."""
    exc = sys.exc_info()[1]
    if isinstance(exc, (QuietAbort, ConnectionError, socket.timeout, ssl.SSLError, BrokenPipeError)):
        log.info("%s: %s", client_address[0], exc)
    else:
        log.exception("request from %s failed", client_address[0])


# ----------------------------------------------------------------------------
# signaling session
# ----------------------------------------------------------------------------

def ws_session(conn):
    st = STATE
    conn.sock.settimeout(JOIN_TIMEOUT)         # a socket that never joins is dropped quickly
    op, raw = conn.recv()
    try:
        msg = json.loads(raw.decode("utf-8")) if op == 0x1 else None
    except ValueError:
        msg = None
    if not isinstance(msg, dict) or msg.get("type") != "join":
        conn.send_json({"type": "error", "code": "bad-join", "message": "first message must be join"})
        return
    code = str(msg.get("room") or "").strip().lower()
    if not CODE_RE.match(code):
        conn.send_json({"type": "error", "code": "bad-code", "message": "that meeting code is not valid"})
        return
    name = clean_name(msg.get("name"))
    state = clean_state(msg.get("state"))
    want_id = msg.get("id")
    want_token = msg.get("token")
    if not (isinstance(want_id, str) and ID_RE.match(want_id) and isinstance(want_token, str)):
        want_id, want_token = None, None

    room = peer = None
    for _attempt in range(3):                  # a room can be pruned between get and join
        room = st.rooms.get_or_create(code, st.settings["allowCreate"])
        if room is None:
            conn.send_json({"type": "error", "code": "no-room", "message": "no meeting with that code"})
            return
        try:
            with room.join_lock:
                peer = room.join(conn, name, state, want_id, want_token, st.settings["maxPeers"])
                # welcome goes out before anyone hears peer-joined, so exactly one
                # side of every pair sees the other in its welcome list.
                conn.sock.settimeout(WS_IDLE_TIMEOUT)
                conn.send_json({
                    "type": "welcome", "id": peer.id, "token": peer.token, "room": room.public(),
                    "peers": [p.public() for p in room.snapshot(exclude=peer)],
                    "chat": room.history(), "config": st.public_config(),
                })
                room.broadcast({"type": "peer-joined", "peer": peer.public()}, exclude=peer)
            break
        except RoomFull:
            conn.send_json({"type": "error", "code": "room-full",
                            "message": "this meeting is full (%d people)" % st.settings["maxPeers"]})
            return
        except RoomClosed:
            room = peer = None
            continue
    if peer is None:
        conn.send_json({"type": "error", "code": "no-room", "message": "that meeting just closed, try again"})
        return

    log.info("join %s -> %s as %r (%d in room)", peer.id, code, name, len(room.snapshot()))
    try:
        while True:
            op, raw = conn.recv()
            if op != 0x1:
                continue
            try:
                msg = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if handle_message(room, peer, msg) is False:
                break
    finally:
        if room.leave(peer):
            log.info("leave %s <- %s (%d left)", peer.id, code, len(room.snapshot()))
            room.broadcast({"type": "peer-left", "id": peer.id, "reason": "left"})


def handle_message(room, peer, msg):
    t = msg.get("type")
    if t == "ping":
        peer.conn.send_json({"type": "pong", "t": msg.get("t")})
    elif t == "signal" or t == "want":
        target = room.find(str(msg.get("to") or ""))
        if target is None or target is peer:
            return True
        if t == "signal":
            data = msg.get("data")
            if isinstance(data, dict):
                target.conn.send_json({"type": "signal", "from": peer.id, "data": data})
        else:
            target.conn.send_json({"type": "want", "from": peer.id, "cam": bool(msg.get("cam", True)),
                                   "screen": bool(msg.get("screen", True))})
    elif t == "state":
        peer.state = clean_state(msg.get("state") if "state" in msg else msg)
        room.broadcast({"type": "state", "id": peer.id, "state": peer.state})
    elif t == "chat":
        text = str(msg.get("text") or "").strip()
        if not text:
            return True
        now = time.time()
        if len(peer.chat_times) == peer.chat_times.maxlen and now - peer.chat_times[0] < 5:
            peer.conn.send_json({"type": "error", "code": "slow-down", "message": "sending too fast"})
            return True
        peer.chat_times.append(now)
        entry = {"id": peer.id, "name": peer.name, "text": text[:MAX_CHAT], "ts": int(now * 1000)}
        room.add_chat(entry)
        room.broadcast(dict(entry, type="chat"))
    elif t == "rename":
        peer.name = clean_name(msg.get("name"))
        room.broadcast({"type": "rename", "id": peer.id, "name": peer.name})
    elif t == "leave":
        return False
    return True


# ----------------------------------------------------------------------------
# lifecycle
# ----------------------------------------------------------------------------

_shutdown = threading.Event()


def request_shutdown(*_):
    _shutdown.set()


def maintenance():
    while not _shutdown.wait(60):
        try:
            STATE.rooms.prune()
        except Exception:
            log.exception("prune failed")


def setup_logging(path):
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if path:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        h = logging.handlers.RotatingFileHandler(path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    else:
        h = logging.StreamHandler(sys.stderr)
    h.setFormatter(fmt)
    root.addHandler(h)


def main(argv=None):
    global STATE
    ap = argparse.ArgumentParser(description="Rooms signaling + static server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", default=os.path.join(ROOT, ".fused", "data"))
    ap.add_argument("--www", default=None)
    ap.add_argument("--log", default=None)
    ap.add_argument("--token", default=None, help="admin token (prefer env ROOMS_ADMIN_TOKEN)")
    ap.add_argument("--public-url", default="")
    ap.add_argument("--tls-cert", default=None)
    ap.add_argument("--tls-key", default=None)
    args = ap.parse_args(argv)
    setup_logging(args.log)
    os.makedirs(args.data, exist_ok=True)
    STATE = State(args)
    if not STATE.token:
        log.warning("no admin token set: /api/status and /api/admin/* are disabled")

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True
        request_queue_size = 64

        def handle_error(self, request, client_address):
            handle_error_quietly(self, request, client_address)

    httpd = Server((args.host, args.port), Handler)
    if args.tls_cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.tls_cert, args.tls_key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    STATE.port = httpd.server_address[1]
    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    threading.Thread(target=maintenance, daemon=True).start()
    t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True)
    t.start()
    log.info("rooms %s listening on %s://%s:%d pid %d www=%s", VERSION, "https" if args.tls_cert else "http",
             args.host, STATE.port, os.getpid(), STATE.www)
    print("READY %d" % STATE.port, flush=True)
    _shutdown.wait()
    log.info("shutting down")
    for r in STATE.rooms.status():
        room = STATE.rooms.get(r["code"])
        if room:
            for p in room.snapshot():
                p.conn.send_json({"type": "closed", "reason": "server stopped"})
                p.conn.close(1001, "server shutting down")
    httpd.shutdown()
    httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
