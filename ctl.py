"""Host-side control for the Rooms app. Called from index.html via fused.runPython.

Owns the server process (server.py) and the optional Cloudflare quick tunnel
that gives colleagues an HTTPS link. All state lives in .fused/data/:
  settings.json  user settings (also read by server.py)
  server.json    {pid, port, token, started, tls}  — written only once the server answers
  tunnel.json    {pid, url, started}               — written only once the URL is known
Logs go to .fused/cache/logs/.

Safety rules: `status` never changes anything; a pid is only ever signalled
after `ps` confirms it is still our server.py / cloudflared (pids get reused);
mutating actions run under a file lock so two console clicks cannot race.
"""
import fcntl
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
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, ".fused", "data")
LOGS = os.path.join(ROOT, ".fused", "cache", "logs")
SERVER_PY = os.path.join(ROOT, "server.py")
SETTINGS_PATH = os.path.join(DATA, "settings.json")
SERVER_JSON = os.path.join(DATA, "server.json")
TUNNEL_JSON = os.path.join(DATA, "tunnel.json")
LOCK_PATH = os.path.join(DATA, "ctl.lock")
TLS_DIR = os.path.join(DATA, "tls")
SERVER_MARK = SERVER_PY          # appears verbatim in our server's command line
TUNNEL_MARK = "cloudflared"
URL_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d+)?$")

DEFAULTS = {
    "port": 8765, "maxPeers": 8, "allowCreate": True, "serverName": "Rooms",
    "camera": "medium", "shareFps": 10,
    "stun": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    "turn": {"urls": "", "username": "", "credential": ""},
    "lan": False, "customPublicUrl": "", "autoTunnel": False,
}
SETTINGS_KEYS = set(DEFAULTS)


class ApiError(RuntimeError):
    pass


# ---------------------------------------------------------------- helpers

def _read(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, obj, private=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), secrets.token_hex(4))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _rm(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _pid(value):
    try:
        pid = int(value)
    except (TypeError, ValueError):
        return None
    return pid if pid > 1 else None


def _owned(pid, marker):
    """True when `pid` is alive AND its command line still contains `marker`."""
    pid = _pid(pid)
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True,
                             text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return marker in out


def _kill(pid, marker, grace=3.0):
    """SIGTERM then SIGKILL — only for a process that is verifiably ours."""
    pid = _pid(pid)
    if pid is None or not _owned(pid, marker):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    t0 = time.time()
    while _owned(pid, marker) and time.time() - t0 < grace:
        time.sleep(0.1)
    if _owned(pid, marker):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return True


@contextmanager
def _locked():
    os.makedirs(DATA, exist_ok=True)
    with open(LOCK_PATH, "a+") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def settings():
    s = json.loads(json.dumps(DEFAULTS))
    on_disk = _read(SETTINGS_PATH, {})
    if isinstance(on_disk, dict):
        for k, v in on_disk.items():
            if k in SETTINGS_KEYS and v is not None:
                s[k] = v
    if not isinstance(s.get("turn"), dict):
        s["turn"] = dict(DEFAULTS["turn"])
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
    """Something already answering on loopback (any bind address) means busy."""
    port = int(port)
    for fam, addr in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(fam, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((addr, port)) == 0:
                    return False
        except OSError:
            pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # same as the server's own bind
            s.bind(("127.0.0.1", port))
    except OSError:
        return False
    return True


def _api(info, path, method="GET", body=None, timeout=3.0):
    """Call the running server's admin API using the recorded token."""
    scheme = "https" if info.get("tls") else "http"
    url = "%s://127.0.0.1:%d%s" % (scheme, int(info["port"]), path)
    data = json.dumps(body or {}).encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "X-Admin-Token": info.get("token", ""), "Content-Type": "application/json"})
    ctx = _ssl._create_unverified_context() if info.get("tls") else None
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error") or ("HTTP %d" % e.code)
        except (ValueError, OSError):
            msg = "HTTP %d" % e.code
        raise ApiError(msg)


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


def _rotate(path, limit=2_000_000):
    try:
        if os.path.getsize(path) > limit:
            with open(path, "wb"):
                pass
    except OSError:
        pass


# ---------------------------------------------------------------- server

def server_info():
    """None when no server of ours is alive; otherwise the record plus
    `responsive` (did /api/status answer) and `status` (its payload)."""
    info = _read(SERVER_JSON, {})
    if not isinstance(info, dict):
        return None
    pid = _pid(info.get("pid"))
    if pid is None or not _owned(pid, SERVER_MARK):
        return None
    info["pid"] = pid
    try:
        info["status"] = _api(info, "/api/status")
        info["responsive"] = True
    except (ApiError, OSError, ValueError, urllib.error.URLError):
        info["status"] = None
        info["responsive"] = False
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
    if info and info["responsive"]:
        return info
    if info:
        raise RuntimeError("The server (pid %d) is running but not answering. Press Stop, then Start." % info["pid"])
    _rm(SERVER_JSON)                       # whatever was there is stale
    s = settings()
    port = int(s["port"])
    if not _port_free(port):
        raise RuntimeError("Port %d is already in use by another program. Change the port in Settings." % port)
    os.makedirs(LOGS, exist_ok=True)
    out_path = os.path.join(LOGS, "server.out")
    _rotate(out_path)
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
    with open(out_path, "ab") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                cwd=ROOT, env=env, start_new_session=True, close_fds=True)
    info = {"pid": proc.pid, "port": port, "token": token, "started": int(time.time() * 1000), "tls": tls}
    t0 = time.time()
    while time.time() - t0 < 10:
        if proc.poll() is not None:
            raise RuntimeError("Server exited immediately:\n" + _tail(out_path, 20))
        try:
            info["status"] = _api(info, "/api/status", timeout=1.0)
            info["responsive"] = True
            _write(SERVER_JSON, {k: info[k] for k in ("pid", "port", "token", "started", "tls")}, private=True)
            return info
        except (ApiError, OSError, ValueError, urllib.error.URLError):
            time.sleep(0.2)
    proc.terminate()
    try:
        proc.wait(3)
    except subprocess.TimeoutExpired:
        proc.kill()
    raise RuntimeError("Server did not answer within 10 s:\n" + _tail(os.path.join(LOGS, "server.log"), 20))


def stop_server():
    info = _read(SERVER_JSON, {})
    if isinstance(info, dict):
        _kill(info.get("pid"), SERVER_MARK)
    _rm(SERVER_JSON)


# ---------------------------------------------------------------- tunnel

def tunnel_info():
    info = _read(TUNNEL_JSON, {})
    if not isinstance(info, dict) or not _owned(info.get("pid"), TUNNEL_MARK):
        return None
    info["pid"] = _pid(info.get("pid"))
    return info


def _find_tunnel_url(text):
    for m in re.findall(r"https://[a-z0-9-]+\.trycloudflare\.com", text):
        if not m.startswith("https://api."):
            return m
    return ""


def start_tunnel(info):
    t = tunnel_info()
    if t and t.get("url"):
        return t
    exe = shutil.which("cloudflared")
    if not exe:
        raise RuntimeError("cloudflared is not installed. Run:  brew install cloudflared")
    _rm(TUNNEL_JSON)
    os.makedirs(LOGS, exist_ok=True)
    logpath = os.path.join(LOGS, "cloudflared.log")
    with open(logpath, "wb"):
        pass
    target = "%s://127.0.0.1:%d" % ("https" if info.get("tls") else "http", int(info["port"]))
    cmd = [exe, "tunnel", "--url", target, "--no-autoupdate", "--loglevel", "info"]
    if info.get("tls"):
        cmd += ["--no-tls-verify"]
    with open(logpath, "ab") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                start_new_session=True, close_fds=True)
    t0 = time.time()
    while time.time() - t0 < 30:
        if proc.poll() is not None:
            raise RuntimeError("cloudflared exited:\n" + _tail(logpath, 15))
        url = _find_tunnel_url(_tail(logpath, 200))
        if url:
            rec = {"pid": proc.pid, "url": url, "started": int(time.time() * 1000)}
            _write(TUNNEL_JSON, rec)
            return rec
        time.sleep(0.4)
    proc.terminate()
    try:
        proc.wait(3)
    except subprocess.TimeoutExpired:
        proc.kill()
    raise RuntimeError("cloudflared did not report a URL within 30 s:\n" + _tail(logpath, 15))


def stop_tunnel():
    t = _read(TUNNEL_JSON, {})
    if isinstance(t, dict):
        _kill(t.get("pid"), TUNNEL_MARK)
    _rm(TUNNEL_JSON)


def public_url_for(s, tunnel):
    if tunnel and tunnel.get("url"):
        return tunnel["url"]
    custom = (s.get("customPublicUrl") or "").strip().rstrip("/")
    return custom if URL_RE.match(custom or "x") and custom else ""


def push_public_url(info):
    if not info or not info.get("responsive", True):
        return
    url = public_url_for(settings(), tunnel_info())
    try:
        _api(info, "/api/admin/public-url", "POST", {"url": url})
    except (ApiError, OSError, ValueError, urllib.error.URLError):
        pass


# ---------------------------------------------------------------- status

def status(extra=None):
    """Read-only snapshot. Never signals, never deletes."""
    s = settings()
    info = server_info()
    t = tunnel_info()
    running = bool(info and info["responsive"])
    stale = bool(info and not info["responsive"])
    ip = lan_ip()
    port = int(info["port"]) if info else int(s["port"])
    scheme = "https" if (info and info.get("tls")) or (not info and s.get("lan")) else "http"
    st = info["status"] if running else {}
    out = {
        "ok": True,
        "settings": s,
        "lanIp": ip,
        "tools": {"cloudflared": shutil.which("cloudflared"), "openssl": bool(shutil.which("openssl"))},
        "server": {
            "running": running, "stale": stale, "pid": info.get("pid") if info else None, "port": port,
            "tls": bool(info and info.get("tls")), "started": info.get("started") if info else None,
            "uptime": st.get("uptime", 0) if running else 0,
            "localUrl": "%s://127.0.0.1:%d" % (scheme, port),
            "lanUrl": ("https://%s:%d" % (ip, port)) if (info and info.get("tls") and ip) else None,
            "rooms": st.get("rooms", []) if running else [],
            "version": st.get("version") if running else None,
            "portFree": _port_free(port) if not info else True,
        },
        "tunnel": {"running": bool(t), "pid": t.get("pid") if t else None, "url": t.get("url") if t else None,
                   "started": t.get("started") if t else None, "orphan": bool(t) and not running},
        "publicUrl": public_url_for(s, t) if running else "",
        "appDir": ROOT,
        "python": sys.executable,
    }
    if extra:
        out.update(extra)
    return out


def _validate_settings(incoming, cur):
    changed_restart = False
    for k, v in incoming.items():
        if k not in SETTINGS_KEYS:
            continue
        try:
            if k == "port":
                v = int(v)
                if not 1024 <= v <= 65535:
                    raise RuntimeError("Port must be between 1024 and 65535")
            elif k == "maxPeers":
                v = max(2, min(16, int(v)))
            elif k == "shareFps":
                v = max(1, min(30, int(v)))
        except (TypeError, ValueError):
            raise RuntimeError("%s must be a number" % k)
        if k in ("lan", "allowCreate", "autoTunnel"):
            v = bool(v)
        if k == "camera" and v not in ("low", "medium", "high"):
            raise RuntimeError("camera must be low, medium or high")
        if k == "serverName":
            v = str(v).strip()[:60] or "Rooms"
        if k == "customPublicUrl":
            v = str(v).strip().rstrip("/")
            if v and not URL_RE.match(v):
                raise RuntimeError("Public URL must look like https://host (no path)")
        if k == "stun":
            if isinstance(v, str):
                v = [x.strip() for x in re.split(r"[,\s]+", v) if x.strip()]
            v = [x for x in (v if isinstance(v, list) else []) if isinstance(x, str) and x.startswith("stun:")]
        if k == "turn":
            v = v if isinstance(v, dict) else {}
            v = {"urls": str(v.get("urls") or "").strip(), "username": str(v.get("username") or "").strip(),
                 "credential": str(v.get("credential") or "")}
            if v["urls"] and not (v["username"] and v["credential"]):
                raise RuntimeError("TURN needs a username and a credential (browsers reject a bare TURN URL)")
            if any(not u.startswith(("turn:", "turns:")) for u in re.split(r"[,\s]+", v["urls"]) if u):
                raise RuntimeError("TURN URLs must start with turn: or turns:")
        if k in ("port", "lan") and cur.get(k) != v:
            changed_restart = True
        cur[k] = v
    return changed_restart


# ---------------------------------------------------------------- entry

def _do(action, label, code, url, settings_json, which, lines):
    if action == "status":
        return status()
    if action == "logs":
        name = {"server": "server.log", "tunnel": "cloudflared.log", "stdout": "server.out"}.get(which, "server.log")
        return {"ok": True, "text": _tail(os.path.join(LOGS, name), lines)}
    if action == "open":
        st = status()
        allowed = [st["server"]["localUrl"], st.get("publicUrl") or "", st["server"].get("lanUrl") or ""]
        if not any(a and url.startswith(a) for a in allowed):
            raise RuntimeError("refusing to open a URL that is not this server's")
        subprocess.Popen(["open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ok": True}
    with _locked():
        if action == "start":
            info = start_server()
            note = None
            if settings().get("autoTunnel"):
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
            if not info or not info["responsive"]:
                info = start_server()
            start_tunnel(info)
            push_public_url(info)
            return status()
        if action == "tunnel_stop":
            stop_tunnel()
            push_public_url(server_info())
            return status()
        if action == "new_room":
            info = server_info()
            if not info or not info["responsive"]:
                info = start_server()
            body = {"label": label.strip()[:40], "save": True}
            if code.strip():
                body["code"] = code.strip().lower()
            r = _api(info, "/api/admin/rooms", "POST", body)
            if not r.get("ok"):
                raise RuntimeError(r.get("error") or "could not create meeting")
            return status({"room": r["room"]})
        if action == "close_room":
            info = server_info()
            if info and info["responsive"] and code:
                _api(info, "/api/admin/rooms/%s/close" % code.strip().lower(), "POST")
            return status()
        if action == "save_settings":
            try:
                incoming = json.loads(settings_json or "{}")
            except ValueError:
                raise RuntimeError("settings must be JSON")
            if not isinstance(incoming, dict):
                raise RuntimeError("settings must be a JSON object")
            cur = settings()
            changed_restart = _validate_settings(incoming, cur)
            _write(SETTINGS_PATH, cur)
            info = server_info()
            if info and info["responsive"]:
                try:
                    _api(info, "/api/admin/reload", "POST")
                except (ApiError, OSError, ValueError, urllib.error.URLError):
                    pass
                push_public_url(info)
            return status({"needsRestart": bool(info) and changed_restart})
    raise RuntimeError("unknown action %r" % action)


def main(action: str = "status", label: str = "", code: str = "", url: str = "",
         settings_json: str = "", which: str = "server", lines: int = 80):
    try:
        return _do(action, label, code, url, settings_json, which, lines)
    except subprocess.CalledProcessError as e:
        out = status()
        out["ok"] = False
        out["error"] = "command failed: %s" % (e.stderr.decode("utf-8", "replace") if e.stderr else e)
        return out
    except (RuntimeError, ValueError, OSError, urllib.error.URLError) as e:
        out = status()
        out["ok"] = False
        out["error"] = str(e)
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
