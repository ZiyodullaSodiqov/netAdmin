#!/usr/bin/env python3
"""
NetAdmin Monitor — lokal dashboard.

    python3 server.py                 # http://127.0.0.1:8800
    python3 server.py --port 9000 --interval 5 --password maxfiy

Faqat Python 3.7+ standart kutubxonasi (Windows / macOS / Linux da ishlaydi).
Har `interval` sekundda barcha serverlardagi agentlarni so'raydi, oxirgi holatni
xotirada, tarixni esa SQLite bazada (monitor.db) saqlaydi.
"""

import argparse
import base64
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
AGENT_DIR = os.path.join(os.path.dirname(HERE), "agent")

LIVE_POINTS = 720  # xotiradagi jonli nuqtalar (5s * 720 = 1 soat)

LEVELS = [
    (0, "light", "Yengil"),
    (50, "normal", "O'rtacha"),
    (75, "heavy", "Og'ir"),
    (90, "critical", "Kritik"),
]

SAMPLE_COLS = ["cpu", "iowait", "load1", "load_pc", "mem", "swap", "disk", "rx", "tx",
               "dr", "dw", "tcp", "procs", "users", "rpm", "temp", "score"]


# --------------------------------------------------------------------------- storage

class DB:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            c = self.conn
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("""CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 9800, token TEXT NOT NULL DEFAULT '', grp TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '', created REAL NOT NULL, snapshot TEXT, last_ok REAL)""")
            c.execute("CREATE TABLE IF NOT EXISTS samples (server_id INTEGER NOT NULL, ts REAL NOT NULL, %s)"
                      % ", ".join("%s REAL" % k for k in SAMPLE_COLS))
            c.execute("CREATE INDEX IF NOT EXISTS samples_idx ON samples(server_id, ts)")
            c.execute("""CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, ts REAL NOT NULL,
                level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL)""")
            c.execute("CREATE INDEX IF NOT EXISTS events_idx ON events(ts)")
            c.commit()

    def q(self, sql, args=(), one=False):
        with self.lock:
            cur = self.conn.execute(sql, args)
            rows = cur.fetchall()
        rows = [dict(r) for r in rows]
        return (rows[0] if rows else None) if one else rows

    def x(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    def xmany(self, sql, rows):
        with self.lock:
            self.conn.executemany(sql, rows)
            self.conn.commit()


# --------------------------------------------------------------------------- analysis

def level_of(score):
    cur = LEVELS[0]
    for lv in LEVELS:
        if score >= lv[0]:
            cur = lv
    return cur


def summarize(snap):
    cpu = (snap.get("cpu") or {}).get("total", 0) or 0
    mem = (snap.get("memory") or {}).get("percent", 0) or 0
    disks = snap.get("disks") or []
    disk = max([d.get("percent", 0) for d in disks] or [0])
    load = snap.get("load") or {}
    load_pc = load.get("per_core", 0) or 0
    swap = (snap.get("memory") or {}).get("swap_percent", 0) or 0
    iowait = (snap.get("cpu") or {}).get("iowait", 0) or 0
    temps = snap.get("temps") or []
    temp = max([t["c"] for t in temps] or [0])
    http = snap.get("http") or {}
    auth = snap.get("auth") or {}
    users = snap.get("users") or []

    # Har bir ko'rsatkich 0-100 shkalaga keltiriladi, eng yomoni yuklama darajasini belgilaydi
    factors = {
        "CPU": cpu,
        "RAM": mem,
        "Disk": disk,
        "Load": min(100.0, load_pc * 80.0),  # load/core = 1.0 -> 80%
        "IO wait": min(100.0, iowait * 3.0),
        "Swap": swap * 0.8 if mem > 80 else swap * 0.4,
    }
    reason = max(factors, key=factors.get)
    score = round(factors[reason], 1)
    _, key, label = level_of(score)
    return {
        "cpu": cpu, "mem": mem, "disk": disk, "load1": load.get("1", 0), "load_pc": load_pc,
        "swap": swap, "iowait": iowait, "temp": temp,
        "rx": (snap.get("net_total") or {}).get("rx", 0), "tx": (snap.get("net_total") or {}).get("tx", 0),
        "dr": (snap.get("disk_io_total") or {}).get("read", 0), "dw": (snap.get("disk_io_total") or {}).get("write", 0),
        "tcp": (snap.get("sockets") or {}).get("established", 0) if isinstance(snap.get("sockets"), dict) else 0,
        "procs": (snap.get("processes") or {}).get("count", 0),
        "users": len(users) if isinstance(users, list) else 0,
        "rpm": http.get("rpm", 0) or 0,
        "failed_24h": auth.get("failed_24h", 0) if isinstance(auth, dict) else 0,
        "score": score, "level": key, "level_label": label, "reason": reason,
        "cores": (snap.get("host") or {}).get("cores", 0),
        "uptime": (snap.get("host") or {}).get("uptime", 0),
        "hostname": (snap.get("host") or {}).get("hostname", ""),
        "os": (snap.get("host") or {}).get("os", ""),
    }


# --------------------------------------------------------------------------- monitor

class ServerState:
    def __init__(self):
        self.status = "unknown"
        self.snapshot = None
        self.summary = None
        self.error = ""
        self.latency = None
        self.last_ok = None
        self.last_try = None
        self.fails = 0
        self.live = deque(maxlen=LIVE_POINTS)
        self.level = None
        self.disk_alert = False
        self.seen_logins = None
        self.last_stored = 0


class Monitor:
    def __init__(self, db, interval, store_every, retention_days, timeout):
        self.db = db
        self.interval = interval
        self.store_every = store_every
        self.retention = retention_days * 86400
        self.timeout = timeout
        self.states = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=64)
        self.wake = threading.Event()
        for s in db.q("SELECT id, snapshot, last_ok FROM servers"):
            st = self.state(s["id"])
            if s["snapshot"]:
                try:
                    st.snapshot = json.loads(s["snapshot"])
                    st.summary = summarize(st.snapshot)
                except ValueError:
                    pass
            st.last_ok = s["last_ok"]

    def state(self, sid):
        with self.lock:
            if sid not in self.states:
                self.states[sid] = ServerState()
            return self.states[sid]

    def forget(self, sid):
        with self.lock:
            self.states.pop(sid, None)

    def event(self, sid, level, kind, message):
        self.db.x("INSERT INTO events(server_id, ts, level, kind, message) VALUES (?,?,?,?,?)",
                  (sid, time.time(), level, kind, message))

    def fetch(self, srv):
        url = "http://%s:%d/metrics" % (srv["host"] if ":" not in srv["host"] else "[%s]" % srv["host"], srv["port"])
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + srv["token"], "User-Agent": "NetAdminMonitor"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode())
        return data, (time.time() - t0) * 1000

    def poll_one(self, srv):
        sid = srv["id"]
        st = self.state(sid)
        st.last_try = time.time()
        name = srv["name"]
        try:
            snap, latency = self.fetch(srv)
        except urllib.error.HTTPError as e:
            err = "HTTP %d: %s" % (e.code, "token noto'g'ri" if e.code == 401 else ("IP ruxsat etilmagan" if e.code == 403 else e.reason))
            return self._fail(sid, st, name, err)
        except Exception as e:
            reason = getattr(e, "reason", e)
            return self._fail(sid, st, name, "Ulanib bo'lmadi: %s" % reason)

        now = time.time()
        summ = summarize(snap)
        if st.status == "offline":
            self.event(sid, "ok", "online", "%s yana ishlayapti (%s)" % (name, srv["host"]))
        st.status = "online"
        st.error = ""
        st.fails = 0
        st.snapshot = snap
        st.summary = summ
        st.latency = round(latency, 1)
        st.last_ok = now
        st.live.append(dict(((k, summ.get(k, 0)) for k in SAMPLE_COLS), ts=now))

        # yuklama darajasi o'zgarishi
        if st.level is not None and summ["level"] != st.level:
            order = [l[1] for l in LEVELS]
            if order.index(summ["level"]) >= 2 and order.index(summ["level"]) > order.index(st.level):
                self.event(sid, "crit" if summ["level"] == "critical" else "warn", "load",
                           "%s: yuklama %s (%s %.0f%%)" % (name, summ["level_label"], summ["reason"], summ["score"]))
            elif order.index(summ["level"]) < 2 <= order.index(st.level):
                self.event(sid, "ok", "load", "%s: yuklama normallashdi (%s)" % (name, summ["level_label"]))
        st.level = summ["level"]

        if summ["disk"] >= 90 and not st.disk_alert:
            st.disk_alert = True
            full = max(snap.get("disks") or [{}], key=lambda d: d.get("percent", 0))
            self.event(sid, "crit", "disk", "%s: disk deyarli to'ldi — %s %.0f%%" % (name, full.get("mount", "?"), summ["disk"]))
        elif summ["disk"] < 85:
            st.disk_alert = False

        self._login_events(sid, st, name, snap)

        if now - st.last_stored >= self.store_every:
            st.last_stored = now
            self.db.x("INSERT INTO samples(server_id, ts, %s) VALUES (?,?,%s)" % (",".join(SAMPLE_COLS), ",".join("?" * len(SAMPLE_COLS))),
                      [sid, now] + [summ.get(k, 0) for k in SAMPLE_COLS])
            self.db.x("UPDATE servers SET snapshot=?, last_ok=? WHERE id=?", (json.dumps(snap), now, sid))

    def _login_events(self, sid, st, name, snap):
        auth = snap.get("auth") if isinstance(snap.get("auth"), dict) else {}
        logins = []
        for a in auth.get("accepted") or []:
            logins.append(("%s|%s|%s" % (a.get("user"), a.get("ip"), a.get("ts")), "%s → %s (%s, %s orqali)" % (name, a.get("user"), a.get("ip"), a.get("method"))))
        if not logins:
            for l in snap.get("logins") or []:
                if isinstance(l, dict) and l.get("user") != "reboot" and l.get("login"):
                    logins.append(("%s|%s|%s" % (l.get("user"), l.get("from"), l.get("login")), "%s → %s (%s, %s)" % (name, l.get("user"), l.get("from"), l.get("tty"))))
        keys = set(k for k, _ in logins)
        if st.seen_logins is None:  # birinchi so'rov — eski kirishlar hodisa emas
            st.seen_logins = keys
            return
        for k, msg in logins:
            if k not in st.seen_logins:
                self.event(sid, "info", "login", "Kirish: " + msg)
        st.seen_logins |= keys

    def _fail(self, sid, st, name, err):
        st.fails += 1
        st.error = err
        st.latency = None
        if st.fails >= 2 and st.status != "offline":
            st.status = "offline"
            self.event(sid, "crit", "offline", "%s javob bermayapti — %s" % (name, err))
        elif st.status == "unknown":
            st.status = "offline" if st.fails >= 2 else "unknown"

    def poll_all(self):
        servers = self.db.q("SELECT id, name, host, port, token FROM servers")
        list(self.pool.map(self.poll_one, servers))

    def poll_now(self, sid):
        srv = self.db.q("SELECT id, name, host, port, token FROM servers WHERE id=?", (sid,), one=True)
        if srv:
            self.pool.submit(self.poll_one, srv)

    def run(self):
        last_prune = 0
        while True:
            t0 = time.time()
            try:
                self.poll_all()
            except Exception as e:
                print("poll xatosi:", e)
            if t0 - last_prune > 3600:
                last_prune = t0
                self.db.x("DELETE FROM samples WHERE ts < ?", (t0 - self.retention,))
                self.db.x("DELETE FROM events WHERE ts < ?", (t0 - self.retention * 4,))
            self.wake.wait(max(0.5, self.interval - (time.time() - t0)))
            self.wake.clear()


# --------------------------------------------------------------------------- HTTP API

def server_row(srv, st):
    summ = st.summary if st else None
    live = list(st.live)[-60:] if st else []
    return {
        "id": srv["id"], "name": srv["name"], "host": srv["host"], "port": srv["port"],
        "group": srv["grp"], "notes": srv["notes"],
        "status": st.status if st else "unknown", "error": st.error if st else "",
        "latency": st.latency if st else None, "last_ok": st.last_ok if st else None,
        "summary": summ,
        "spark": [round(p["cpu"], 1) for p in live],
        "spark_mem": [round(p["mem"], 1) for p in live],
    }


def make_handler(db, mon, password):
    class Handler(BaseHTTPRequestHandler):
        server_version = "NetAdminMonitor/1.0"

        def log_message(self, *args):
            pass

        def _auth_ok(self):
            if not password:
                return True
            h = self.headers.get("Authorization", "")
            if h.startswith("Basic "):
                try:
                    user_pass = base64.b64decode(h[6:]).decode()
                    if hmac.compare_digest(user_pass.split(":", 1)[-1].encode(), password.encode()):
                        return True
                except Exception:
                    pass
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="NetAdmin Monitor"')
            self.end_headers()
            return False

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            try:
                return json.loads(self.rfile.read(n).decode())
            except ValueError:
                return {}

        def _file(self, path, download_name=None):
            if not os.path.isfile(path):
                return self._json({"error": "topilmadi"}, 404)
            with open(path, "rb") as f:
                data = f.read()
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if path.endswith(".js"):
                ctype = "application/javascript"
            self.send_response(200)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))
            self.send_header("Content-Length", str(len(data)))
            if download_name:
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
            self.end_headers()
            self.wfile.write(data)

        # ---- routing
        def do_GET(self):
            if not self._auth_ok():
                return
            u = urlparse(self.path)
            p = u.path.rstrip("/") or "/"
            qs = parse_qs(u.query)
            parts = p.strip("/").split("/")
            try:
                if p == "/api/servers":
                    return self._json(self.list_servers())
                if p == "/api/overview":
                    return self._json(self.overview())
                if p == "/api/events":
                    return self._json(self.events(qs))
                if p == "/api/token":
                    return self._json({"token": secrets.token_hex(24)})
                if len(parts) == 3 and parts[:2] == ["api", "servers"]:
                    return self.server_detail(int(parts[2]))
                if len(parts) == 4 and parts[:2] == ["api", "servers"] and parts[3] == "history":
                    return self._json(self.history(int(parts[2]), int((qs.get("range") or ["3600"])[0])))
                if p == "/download/netadmin_agent.py":
                    return self._file(os.path.join(AGENT_DIR, "netadmin_agent.py"), "netadmin_agent.py")
                if p == "/download/install.sh":
                    return self._file(os.path.join(AGENT_DIR, "install.sh"), "install.sh")
                if p == "/":
                    return self._file(os.path.join(STATIC, "index.html"))
                safe = os.path.normpath(os.path.join(STATIC, p.lstrip("/")))
                if safe.startswith(STATIC + os.sep):
                    return self._file(safe)
                return self._json({"error": "topilmadi"}, 404)
            except ValueError:
                return self._json({"error": "noto'g'ri so'rov"}, 400)

        def do_POST(self):
            if not self._auth_ok():
                return
            p = urlparse(self.path).path.rstrip("/")
            parts = p.strip("/").split("/")
            body = self._body()
            if p == "/api/servers":
                return self.add_server(body)
            if p == "/api/servers/bulk":
                return self.bulk_add(body)
            if len(parts) == 4 and parts[:2] == ["api", "servers"] and parts[3] == "poll":
                mon.poll_now(int(parts[2]))
                return self._json({"ok": True})
            if p == "/api/events/clear":
                db.x("DELETE FROM events")
                return self._json({"ok": True})
            return self._json({"error": "topilmadi"}, 404)

        def do_PUT(self):
            if not self._auth_ok():
                return
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "servers"]:
                return self.update_server(int(parts[2]), self._body())
            return self._json({"error": "topilmadi"}, 404)

        def do_DELETE(self):
            if not self._auth_ok():
                return
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "servers"]:
                sid = int(parts[2])
                srv = db.q("SELECT name FROM servers WHERE id=?", (sid,), one=True)
                db.x("DELETE FROM servers WHERE id=?", (sid,))
                db.x("DELETE FROM samples WHERE server_id=?", (sid,))
                mon.forget(sid)
                if srv:
                    mon.event(None, "info", "server", "Server o'chirildi: %s" % srv["name"])
                return self._json({"ok": True})
            return self._json({"error": "topilmadi"}, 404)

        # ---- handlers
        def list_servers(self):
            rows = db.q("SELECT * FROM servers ORDER BY grp, name")
            return [server_row(r, mon.states.get(r["id"])) for r in rows]

        def overview(self):
            rows = self.list_servers()
            counts = {"total": len(rows), "online": 0, "offline": 0, "unknown": 0,
                      "light": 0, "normal": 0, "heavy": 0, "critical": 0}
            cpu = mem = 0.0
            rx = tx = rpm = 0.0
            users = failed = 0
            n = 0
            for r in rows:
                counts[r["status"]] = counts.get(r["status"], 0) + 1
                s = r["summary"]
                if r["status"] == "online" and s:
                    n += 1
                    counts[s["level"]] += 1
                    cpu += s["cpu"]
                    mem += s["mem"]
                    rx += s["rx"]
                    tx += s["tx"]
                    rpm += s["rpm"]
                    users += s["users"]
                    failed += s["failed_24h"]
            return {"counts": counts, "avg_cpu": round(cpu / n, 1) if n else 0, "avg_mem": round(mem / n, 1) if n else 0,
                    "rx": rx, "tx": tx, "rpm": round(rpm, 1), "users": users, "failed_24h": failed,
                    "interval": mon.interval}

        def events(self, qs):
            limit = min(500, int((qs.get("limit") or ["100"])[0]))
            sid = (qs.get("server") or [None])[0]
            if sid:
                rows = db.q("SELECT e.*, s.name AS server FROM events e LEFT JOIN servers s ON s.id=e.server_id "
                            "WHERE e.server_id=? ORDER BY e.ts DESC LIMIT ?", (int(sid), limit))
            else:
                rows = db.q("SELECT e.*, s.name AS server FROM events e LEFT JOIN servers s ON s.id=e.server_id "
                            "ORDER BY e.ts DESC LIMIT ?", (limit,))
            return rows

        def server_detail(self, sid):
            srv = db.q("SELECT * FROM servers WHERE id=?", (sid,), one=True)
            if not srv:
                return self._json({"error": "server topilmadi"}, 404)
            st = mon.states.get(sid)
            row = server_row(srv, st)
            row["token_hint"] = (srv["token"][:4] + "…" + srv["token"][-4:]) if len(srv["token"]) > 8 else "****"
            row["snapshot"] = st.snapshot if st else None
            return self._json(row)

        def history(self, sid, rng):
            rng = max(300, min(rng, 30 * 86400))
            now = time.time()
            st = mon.states.get(sid)
            live = list(st.live) if st else []
            if rng <= 3600 and live and live[0]["ts"] <= now - rng * 0.9:
                pts = [p for p in live if p["ts"] >= now - rng]
                return {"range": rng, "points": pts}
            bucket = max(mon.store_every, rng // 300)
            rows = db.q("SELECT CAST(ts / ? AS INTEGER) * ? AS bts, %s FROM samples WHERE server_id=? AND ts>=? "
                        "GROUP BY CAST(ts / ? AS INTEGER) ORDER BY bts"
                        % ", ".join("AVG(%s) AS %s" % (k, k) for k in SAMPLE_COLS),
                        (bucket, bucket, sid, now - rng, bucket))
            for r in rows:
                r["ts"] = r.pop("bts")
            if rng <= 3600 and st:  # jonli nuqtalar bilan to'ldirish
                last = rows[-1]["ts"] if rows else 0
                rows += [p for p in live if p["ts"] > last + bucket]
            return {"range": rng, "points": rows}

        def _clean(self, body):
            name = str(body.get("name") or "").strip()
            host = str(body.get("host") or "").strip()
            if not host:
                raise ValueError("IP manzil kiritilmagan")
            try:
                port = int(body.get("port") or 9800)
            except (TypeError, ValueError):
                raise ValueError("Port noto'g'ri")
            return {"name": name or host, "host": host, "port": port, "token": str(body.get("token") or "").strip(),
                    "grp": str(body.get("group") or "").strip(), "notes": str(body.get("notes") or "").strip()}

        def add_server(self, body):
            try:
                s = self._clean(body)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            if db.q("SELECT id FROM servers WHERE host=? AND port=?", (s["host"], s["port"]), one=True):
                return self._json({"error": "Bu IP:port allaqachon qo'shilgan"}, 409)
            sid = db.x("INSERT INTO servers(name, host, port, token, grp, notes, created) VALUES (?,?,?,?,?,?,?)",
                       (s["name"], s["host"], s["port"], s["token"], s["grp"], s["notes"], time.time()))
            mon.event(sid, "info", "server", "Server qo'shildi: %s (%s)" % (s["name"], s["host"]))
            mon.poll_now(sid)
            return self._json({"ok": True, "id": sid})

        def bulk_add(self, body):
            added, errors = 0, []
            for i, line in enumerate(str(body.get("text") or "").splitlines(), 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                f = [x.strip() for x in line.replace(";", ",").split(",")]
                rec = {"name": f[0] if len(f) > 1 else "", "host": f[1] if len(f) > 1 else f[0],
                       "port": f[2] if len(f) > 2 and f[2] else 9800,
                       "token": f[3] if len(f) > 3 else body.get("token", ""), "group": f[4] if len(f) > 4 else body.get("group", "")}
                try:
                    s = self._clean(rec)
                except ValueError as e:
                    errors.append("%d-qator: %s" % (i, e))
                    continue
                if db.q("SELECT id FROM servers WHERE host=? AND port=?", (s["host"], s["port"]), one=True):
                    errors.append("%d-qator: %s allaqachon bor" % (i, s["host"]))
                    continue
                sid = db.x("INSERT INTO servers(name, host, port, token, grp, notes, created) VALUES (?,?,?,?,?,?,?)",
                           (s["name"], s["host"], s["port"], s["token"], s["grp"], s["notes"], time.time()))
                mon.poll_now(sid)
                added += 1
            if added:
                mon.event(None, "info", "server", "%d ta server qo'shildi" % added)
            return self._json({"ok": True, "added": added, "errors": errors})

        def update_server(self, sid, body):
            srv = db.q("SELECT * FROM servers WHERE id=?", (sid,), one=True)
            if not srv:
                return self._json({"error": "server topilmadi"}, 404)
            if not body.get("token"):
                body["token"] = srv["token"]  # bo'sh qoldirilsa eski token saqlanadi
            try:
                s = self._clean(body)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            db.x("UPDATE servers SET name=?, host=?, port=?, token=?, grp=?, notes=? WHERE id=?",
                 (s["name"], s["host"], s["port"], s["token"], s["grp"], s["notes"], sid))
            mon.poll_now(sid)
            return self._json({"ok": True})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="NetAdmin Monitor dashboard")
    ap.add_argument("--host", default="127.0.0.1", help="tinglash manzili (tarmoqdan kirish uchun 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--interval", type=float, default=5, help="serverlarni so'rash oralig'i, sekund")
    ap.add_argument("--store-every", type=int, default=30, help="tarixga yozish oralig'i, sekund")
    ap.add_argument("--retention-days", type=int, default=14, help="tarix necha kun saqlanadi")
    ap.add_argument("--timeout", type=float, default=4, help="agentdan javob kutish, sekund")
    ap.add_argument("--db", default=os.path.join(HERE, "monitor.db"))
    ap.add_argument("--password", default=os.environ.get("NETADMIN_DASHBOARD_PASSWORD", ""),
                    help="dashboardga kirish paroli (0.0.0.0 da ochsangiz tavsiya etiladi)")
    args = ap.parse_args()

    db = DB(args.db)
    mon = Monitor(db, args.interval, args.store_every, args.retention_days, args.timeout)
    threading.Thread(target=mon.run, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(db, mon, args.password))
    httpd.daemon_threads = True
    print("NetAdmin Monitor: http://%s:%d" % ("127.0.0.1" if args.host == "0.0.0.0" else args.host, args.port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
