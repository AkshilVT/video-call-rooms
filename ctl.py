"""Host-side control for the Rooms app. Called from index.html via fused.runPython.

Owns the server process (server.py) and the optional Cloudflare quick tunnel
that gives colleagues an HTTPS link. All state lives in .fused/data/:
  settings.json  user settings (also read by server.py)
  server.json    {pid, port, token, started, tls}
  tunnel.json    {pid, url, started}
Logs go to .fused/cache/logs/.
"""
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import ssl as _ssl

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, ".fused", "data")
LOGS = os.path.join(ROOT, ".fused", "cache", "logs")
SERVER_PY = os.path.join(ROOT, "server.py")
SETTINGS_PATH = os.path.join(DATA, "settings.json")
SERVER_JSON = os.path.join(DATA, "server.json")
TUNNEL_JSON = os.path.join(DATA, "tunnel.json")
TLS_DIR = os.path.join(DATA, "tls")

DEFAULTS = {
    "port": 8765, "maxPeers": 8, "allowCreate": True, "serverName": "Rooms",
    "camera": "medium", "shareFps": 10,
    "stun": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    "turn": {"urls": "", "username": "", "credential": ""},
    "lan": False, "customPublicUrl": "", "autoTunnel": False,
}
SETTINGS_KEYS = set(DEFAULTS)


# ---------------------------------------------------------------- helpers

def _read(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, obj, private=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def _kill(pid, grace=3.0):
    if not _alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    t0 = time.time()
    while _alive(pid) and time.time() - t0 < grace:
        time.sleep(0.1)
    if _alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def settings():
    s = dict(DEFAULTS)
    on_disk = _read(SETTINGS_PATH, {})
    if isinstance(on_disk, dict):
        for k, v in on_disk.items():
            if k in SETTINGS_KEYS and v is not None:
                s[k] = v
    return s


def lan_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return None


def _port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", int(port)))
            return True
        except OSError:
            return False


def _api(info, path, method="GET", body=None, timeout=3.0):
    """Call the running server's admin API using the recorded token."""
    scheme = "https" if info.get("tls") else "http"
    url = "%s://127.0.0.1:%d%s" % (scheme, int(info["port"]), path)
    data = json.dumps(body or {}).encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "X-Admin-Token": info.get("token", ""), "Content-Type": "application/json"})
    ctx = _ssl._create_unverified_context() if info.get("tls") else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return json.loads(r.read().decode("utf-8"))


def _tail(path, lines=80):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 64 * 1024))
            text = f.read().decode("utf-8", "replace")
        return "\n".join(text.splitlines()[-int(lines):])
    except OSError:
        return ""


# ---------------------------------------------------------------- server

def server_info():
    info = _read(SERVER_JSON, {})
    if not isinstance(info, dict) or not _alive(info.get("pid")):
        return None
    try:
        info["status"] = _api(info, "/api/status")
    except (OSError, ValueError, urllib.error.URLError):
        return None       # pid reused or server wedged: treat as not running
    return info


def _ensure_tls(ip):
    os.makedirs(TLS_DIR, exist_ok=True)
    cert, key = os.path.join(TLS_DIR, "cert.pem"), os.path.join(TLS_DIR, "key.pem")
    stamp = os.path.join(TLS_DIR, "san.txt")
    san = "DNS:localhost,IP:127.0.0.1" + (",IP:%s" % ip if ip else "")
    if os.path.exists(cert) and os.path.exists(key) and _read_text(stamp) == san:
        return cert, key
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
           "-days", "3650", "-subj", "/CN=Rooms LAN", "-addext", "subjectAltName=" + san]
    subprocess.run(cmd, check=True, capture_output=True)
    with open(stamp, "w", encoding="utf-8") as f:
        f.write(san)
    return cert, key


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def start_server():
    info = server_info()
    if info:
        return info
    s = settings()
    port = int(s["port"])
    if not _port_free(port):
        raise RuntimeError("Port %d is already in use by another program. Change the port in Settings." % port)
    os.makedirs(LOGS, exist_ok=True)
    token = secrets.token_urlsafe(24)
    cmd = [sys.executable, SERVER_PY, "--port", str(port), "--data", DATA, "--log", os.path.join(LOGS, "server.log")]
    tls = False
    if s.get("lan"):
        cert, key = _ensure_tls(lan_ip())
        cmd += ["--host", "0.0.0.0", "--tls-cert", cert, "--tls-key", key]
        tls = True
    public = public_url_for(s, tunnel_info())
    if public:
        cmd += ["--public-url", public]
    env = dict(os.environ, ROOMS_ADMIN_TOKEN=token, PYTHONUNBUFFERED="1")
    out = open(os.path.join(LOGS, "server.out"), "ab")
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                            cwd=ROOT, env=env, start_new_session=True, close_fds=True)
    info = {"pid": proc.pid, "port": port, "token": token, "started": int(time.time() * 1000), "tls": tls}
    _write(SERVER_JSON, info, private=True)
    t0 = time.time()
    while time.time() - t0 < 10:
        if proc.poll() is not None:
            raise RuntimeError("Server exited immediately:\n" + _tail(os.path.join(LOGS, "server.out"), 20))
        try:
            info["status"] = _api(info, "/api/status", timeout=1.0)
            return info
        except (OSError, ValueError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError("Server did not answer within 10 s:\n" + _tail(os.path.join(LOGS, "server.log"), 20))


def stop_server():
    info = _read(SERVER_JSON, {})
    if isinstance(info, dict) and _alive(info.get("pid")):
        _kill(int(info["pid"]))
    try:
        os.remove(SERVER_JSON)
    except OSError:
        pass


# ---------------------------------------------------------------- tunnel

def tunnel_info():
    info = _read(TUNNEL_JSON, {})
    if not isinstance(info, dict) or not _alive(info.get("pid")):
        return None
    return info


def start_tunnel(info):
    t = tunnel_info()
    if t and t.get("url"):
        return t
    exe = shutil.which("cloudflared")
    if not exe:
        raise RuntimeError("cloudflared is not installed. Run:  brew install cloudflared")
    os.makedirs(LOGS, exist_ok=True)
    logpath = os.path.join(LOGS, "cloudflared.log")
    with open(logpath, "wb"):
        pass
    target = "%s://127.0.0.1:%d" % ("https" if info.get("tls") else "http", int(info["port"]))
    cmd = [exe, "tunnel", "--url", target, "--no-autoupdate", "--loglevel", "info"]
    if info.get("tls"):
        cmd += ["--no-tls-verify"]
    out = open(logpath, "ab")
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                            start_new_session=True, close_fds=True)
    rec = {"pid": proc.pid, "url": "", "started": int(time.time() * 1000)}
    _write(TUNNEL_JSON, rec)
    t0 = time.time()
    while time.time() - t0 < 30:
        if proc.poll() is not None:
            raise RuntimeError("cloudflared exited:\n" + _tail(logpath, 15))
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", _tail(logpath, 200))
        if m:
            rec["url"] = m.group(0)
            _write(TUNNEL_JSON, rec)
            return rec
        time.sleep(0.4)
    _kill(proc.pid)
    raise RuntimeError("cloudflared did not report a URL within 30 s:\n" + _tail(logpath, 15))


def stop_tunnel():
    t = _read(TUNNEL_JSON, {})
    if isinstance(t, dict) and _alive(t.get("pid")):
        _kill(int(t["pid"]))
    try:
        os.remove(TUNNEL_JSON)
    except OSError:
        pass


def public_url_for(s, tunnel):
    if tunnel and tunnel.get("url"):
        return tunnel["url"]
    custom = (s.get("customPublicUrl") or "").strip().rstrip("/")
    return custom or ""


def push_public_url(info):
    if not info:
        return
    url = public_url_for(settings(), tunnel_info())
    try:
        _api(info, "/api/admin/public-url", "POST", {"url": url})
    except (OSError, ValueError, urllib.error.URLError):
        pass


# ---------------------------------------------------------------- status

def status(extra=None):
    s = settings()
    info = server_info()
    t = tunnel_info()
    if t and not info:
        stop_tunnel()       # a tunnel without a server is useless
        t = None
    ip = lan_ip()
    port = int(info["port"]) if info else int(s["port"])
    scheme = "https" if (info and info.get("tls")) or (not info and s.get("lan")) else "http"
    out = {
        "ok": True,
        "settings": s,
        "lanIp": ip,
        "tools": {"cloudflared": shutil.which("cloudflared"), "openssl": bool(shutil.which("openssl"))},
        "server": {
            "running": bool(info), "pid": info.get("pid") if info else None, "port": port,
            "tls": bool(info and info.get("tls")), "started": info.get("started") if info else None,
            "uptime": (info["status"].get("uptime") if info else 0),
            "localUrl": "%s://127.0.0.1:%d" % (scheme, port),
            "lanUrl": ("https://%s:%d" % (ip, port)) if (info and info.get("tls") and ip) else None,
            "rooms": info["status"].get("rooms", []) if info else [],
            "version": info["status"].get("version") if info else None,
            "portFree": _port_free(port) if not info else True,
        },
        "tunnel": {"running": bool(t), "pid": t.get("pid") if t else None, "url": t.get("url") if t else None,
                   "started": t.get("started") if t else None},
        "publicUrl": public_url_for(s, t) if info else "",
        "appDir": ROOT,
        "python": sys.executable,
    }
    if extra:
        out.update(extra)
    return out


# ---------------------------------------------------------------- entry

def main(action: str = "status", label: str = "", code: str = "", url: str = "",
         settings_json: str = "", which: str = "server", lines: int = 80):
    try:
        if action == "status":
            return status()
        if action == "start":
            info = start_server()
            s = settings()
            note = None
            if s.get("autoTunnel"):
                try:
                    start_tunnel(info)
                except RuntimeError as e:
                    note = str(e)
            push_public_url(info)
            return status({"note": note} if note else None)
        if action == "stop":
            stop_tunnel()
            stop_server()
            return status()
        if action == "restart":
            info = server_info()
            had_tunnel = bool(tunnel_info())
            stop_tunnel()
            stop_server()
            info = start_server()
            if had_tunnel:
                start_tunnel(info)
            push_public_url(info)
            return status()
        if action == "tunnel_start":
            info = server_info()
            if not info:
                info = start_server()
            start_tunnel(info)
            push_public_url(info)
            return status()
        if action == "tunnel_stop":
            stop_tunnel()
            push_public_url(server_info())
            return status()
        if action == "new_room":
            info = server_info() or start_server()
            body = {"label": label.strip()[:40], "save": True}
            if code.strip():
                body["code"] = code.strip().lower()
            r = _api(info, "/api/admin/rooms", "POST", body)
            if not r.get("ok"):
                raise RuntimeError(r.get("error") or "could not create meeting")
            return status({"room": r["room"]})
        if action == "close_room":
            info = server_info()
            if info and code:
                _api(info, "/api/admin/rooms/%s/close" % code, "POST")
            return status()
        if action == "save_settings":
            incoming = json.loads(settings_json or "{}")
            cur = settings()
            changed_restart = False
            for k, v in incoming.items():
                if k not in SETTINGS_KEYS:
                    continue
                if k in ("port",):
                    v = int(v)
                    if not 1024 <= v <= 65535:
                        raise RuntimeError("Port must be between 1024 and 65535")
                if k in ("maxPeers", "shareFps"):
                    v = int(v)
                if k in ("lan", "allowCreate", "autoTunnel"):
                    v = bool(v)
                if k == "stun" and isinstance(v, str):
                    v = [x.strip() for x in re.split(r"[,\s]+", v) if x.strip()]
                if k in ("port", "lan") and cur.get(k) != v:
                    changed_restart = True
                cur[k] = v
            _write(SETTINGS_PATH, cur)
            info = server_info()
            if info:
                try:
                    _api(info, "/api/admin/reload", "POST")
                except (OSError, ValueError, urllib.error.URLError):
                    pass
                push_public_url(info)
            return status({"needsRestart": bool(info) and changed_restart})
        if action == "open":
            st = status()
            allowed = [st["server"]["localUrl"], st.get("publicUrl") or "", st["server"].get("lanUrl") or ""]
            if not any(a and url.startswith(a) for a in allowed):
                raise RuntimeError("refusing to open a URL that is not this server's")
            subprocess.Popen(["open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True}
        if action == "logs":
            name = {"server": "server.log", "tunnel": "cloudflared.log", "stdout": "server.out"}.get(which, "server.log")
            return {"ok": True, "text": _tail(os.path.join(LOGS, name), lines)}
        raise RuntimeError("unknown action %r" % action)
    except RuntimeError as e:
        out = status()
        out["ok"] = False
        out["error"] = str(e)
        return out
    except subprocess.CalledProcessError as e:
        out = status()
        out["ok"] = False
        out["error"] = "command failed: %s" % (e.stderr.decode("utf-8", "replace") if e.stderr else e)
        return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("action", nargs="?", default="status")
    ap.add_argument("--label", default="")
    ap.add_argument("--code", default="")
    ap.add_argument("--url", default="")
    ap.add_argument("--settings", default="")
    a = ap.parse_args()
    print(json.dumps(main(a.action, a.label, a.code, a.url, a.settings), indent=1))
