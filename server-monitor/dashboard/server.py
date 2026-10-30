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
import ipaddress
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

import api_ext
import digitalocean
import notify
import sites as sitesmod
from installer import Installer

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
            if "site_id" not in [r[1] for r in c.execute("PRAGMA table_info(events)")]:
                c.execute("ALTER TABLE events ADD COLUMN site_id INTEGER")
            c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            c.execute("""CREATE TABLE IF NOT EXISTS uptime (server_id INTEGER NOT NULL, day TEXT NOT NULL,
                ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(server_id, day))""")
            c.execute("""CREATE TABLE IF NOT EXISTS known_ips (server_id INTEGER NOT NULL, ip TEXT NOT NULL,
                first_seen REAL NOT NULL, PRIMARY KEY(server_id, ip))""")
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

    def settings(self):
        return {r["key"]: r["value"] for r in self.q("SELECT key, value FROM settings")}

    def set_setting(self, key, value):
        self.x("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)", (key, str(value)))


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
        self.forecast = None
        self.forecast_warned = None


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
        self.hooks = []
        self.uptime = {}
        self.uptime_lock = threading.Lock()
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

    def event(self, sid, level, kind, message, site_id=None):
        self.db.x("INSERT INTO events(server_id, ts, level, kind, message, site_id) VALUES (?,?,?,?,?,?)",
                  (sid, time.time(), level, kind, message, site_id))
        for hook in self.hooks:
            try:
                hook(sid, level, kind, message)
            except Exception as e:
                print("hodisa hook xatosi:", e)

    def count_uptime(self, sid, ok):
        key = (sid, time.strftime("%Y-%m-%d"))
        with self.uptime_lock:
            c = self.uptime.setdefault(key, [0, 0])
            c[0 if ok else 1] += 1

    def flush_uptime(self):
        with self.uptime_lock:
            items, self.uptime = self.uptime, {}
        for (sid, day), (ok, fail) in items.items():
            self.db.x("INSERT INTO uptime(server_id, day, ok, fail) VALUES (?,?,?,?) "
                      "ON CONFLICT(server_id, day) DO UPDATE SET ok=ok+excluded.ok, fail=fail+excluded.fail", (sid, day, ok, fail))

    def uptime_pct(self, sid, days):
        since = time.strftime("%Y-%m-%d", time.localtime(time.time() - (days - 1) * 86400))
        r = self.db.q("SELECT SUM(ok) AS ok, SUM(fail) AS fail FROM uptime WHERE server_id=? AND day>=?", (sid, since), one=True)
        ok, fail = (r["ok"] or 0), (r["fail"] or 0)
        with self.uptime_lock:
            for (s2, day), (o2, f2) in self.uptime.items():
                if s2 == sid and day >= since:
                    ok, fail = ok + o2, fail + f2
        return round(100.0 * ok / (ok + fail), 2) if ok + fail else None

    def compute_forecasts(self):
        """Disk to'lishi bashorati: oxirgi 7 kunlik disk% bo'yicha chiziqli regressiya."""
        for srv in self.db.q("SELECT id, name FROM servers"):
            st = self.states.get(srv["id"])
            if not st:
                continue
            rows = self.db.q("SELECT ts, disk FROM samples WHERE server_id=? AND ts>=? ORDER BY ts", (srv["id"], time.time() - 7 * 86400))
            if len(rows) < 20 or rows[-1]["ts"] - rows[0]["ts"] < 6 * 3600:
                st.forecast = None
                continue
            n = len(rows)
            t0 = rows[0]["ts"]
            xs = [(r["ts"] - t0) / 86400.0 for r in rows]
            ys = [r["disk"] or 0 for r in rows]
            mx, my = sum(xs) / n, sum(ys) / n
            den = sum((x - mx) ** 2 for x in xs) or 1
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den  # % / kun
            cur = (st.summary or {}).get("disk", ys[-1])
            days = (100.0 - cur) / slope if slope > 0.02 else None
            st.forecast = {"slope": round(slope, 3), "days": round(days, 1) if days is not None else None,
                           "current": cur, "span_h": round((rows[-1]["ts"] - t0) / 3600, 1)}
            lvl = None
            if days is not None:
                lvl = 3 if days <= 3 else (14 if days <= 14 else None)
            if lvl and st.forecast_warned != lvl:
                st.forecast_warned = lvl
                self.event(srv["id"], "crit" if lvl == 3 else "warn", "forecast",
                           "%s: disk shu tezlikda ~%.0f kunda to'ladi (hozir %.0f%%, kuniga +%.2f%%)" % (srv["name"], days, cur, slope))
            elif not lvl:
                st.forecast_warned = None

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
        self.count_uptime(sid, True)
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
        logins = []  # (kalit, ip, xabar)
        for a in auth.get("accepted") or []:
            logins.append(("%s|%s|%s" % (a.get("user"), a.get("ip"), a.get("ts")), a.get("ip"),
                           "%s → %s (%s, %s orqali)" % (name, a.get("user"), a.get("ip"), a.get("method"))))
        if not logins:
            for l in snap.get("logins") or []:
                if isinstance(l, dict) and l.get("user") != "reboot" and l.get("login"):
                    logins.append(("%s|%s|%s" % (l.get("user"), l.get("from"), l.get("login")), l.get("from"),
                                   "%s → %s (%s, %s)" % (name, l.get("user"), l.get("from"), l.get("tty"))))
        keys = set(k for k, _, _ in logins)
        known = set(r["ip"] for r in self.db.q("SELECT ip FROM known_ips WHERE server_id=?", (sid,)))
        if st.seen_logins is None:  # birinchi so'rov — eski kirishlar hodisa emas, ularning IP lari "tanish" hisoblanadi
            st.seen_logins = keys
            new = set(ip for _, ip, _ in logins if ip) - known
            if new:
                self.db.xmany("INSERT OR IGNORE INTO known_ips VALUES (?,?,?)", [(sid, ip, time.time()) for ip in new])
            return
        for k, ip, msg in logins:
            if k in st.seen_logins:
                continue
            if ip and ip not in known and ip not in ("lokal", ""):
                geo = getattr(self, "geo", None)
                g = geo.get(ip) if geo else None
                where = (" — %s%s" % (g.get("country") or "", (", " + g["city"]) if g and g.get("city") else "")) if g and g.get("country") else ""
                self.event(sid, "warn", "login_new", "Notanish IP dan kirish: %s%s" % (msg, where))
                self.db.x("INSERT OR IGNORE INTO known_ips VALUES (?,?,?)", (sid, ip, time.time()))
                known.add(ip)
            else:
                self.event(sid, "info", "login", "Kirish: " + msg)
        st.seen_logins |= keys

    def _fail(self, sid, st, name, err):
        self.count_uptime(sid, False)
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
        last_flush = time.time()
        last_forecast = time.time() - 540  # birinchi bashorat ~1 daqiqadan keyin
        while True:
            t0 = time.time()
            try:
                self.poll_all()
            except Exception as e:
                print("poll xatosi:", e)
            if t0 - last_flush > 60:
                last_flush = t0
                self.flush_uptime()
            if t0 - last_forecast > 600:
                last_forecast = t0
                try:
                    self.compute_forecasts()
                except Exception as e:
                    print("bashorat xatosi:", e)
            if t0 - last_prune > 3600:
                last_prune = t0
                self.db.x("DELETE FROM samples WHERE ts < ?", (t0 - self.retention,))
                self.db.x("DELETE FROM events WHERE ts < ?", (t0 - self.retention * 4,))
            self.wake.wait(max(0.5, self.interval - (time.time() - t0)))
            self.wake.clear()


# --------------------------------------------------------------------------- GeoIP

def is_public(ip):
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


class GeoIP:
    """IP -> mamlakat/shahar/koordinata. ip-api.com (bepul, kalitsiz), natija SQLite da keshlanadi."""

    URL = "http://ip-api.com/batch?fields=status,country,countryCode,city,lat,lon,isp,as,query"

    def __init__(self, db, enabled=True):
        self.db = db
        self.enabled = enabled
        self.pending = set()
        self.lock = threading.Lock()
        self.cache = {}
        self.last_error = ""
        db.x("""CREATE TABLE IF NOT EXISTS geo (ip TEXT PRIMARY KEY, country TEXT, cc TEXT, city TEXT,
                lat REAL, lon REAL, isp TEXT, asn TEXT, ts REAL)""")
        for r in db.q("SELECT * FROM geo"):
            self.cache[r["ip"]] = r
        if enabled:
            threading.Thread(target=self.run, daemon=True).start()

    def get(self, ip):
        g = self.cache.get(ip)
        if g is None and self.enabled and is_public(ip):
            with self.lock:
                self.pending.add(ip)
        return g

    def pending_count(self):
        with self.lock:
            return len(self.pending)

    def run(self):
        while True:
            with self.lock:
                batch = [ip for ip in list(self.pending)[:100]]
            if not batch:
                time.sleep(2)
                continue
            try:
                req = urllib.request.Request(self.URL, data=json.dumps(batch).encode(),
                                             headers={"Content-Type": "application/json", "User-Agent": "NetAdminMonitor"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    res = json.loads(r.read().decode())
                rows = []
                for g in res:
                    ip = g.get("query")
                    if g.get("status") == "success":
                        row = {"ip": ip, "country": g.get("country", ""), "cc": g.get("countryCode", ""), "city": g.get("city", ""),
                               "lat": g.get("lat"), "lon": g.get("lon"), "isp": g.get("isp", ""), "asn": g.get("as", ""), "ts": time.time()}
                    else:
                        row = {"ip": ip, "country": "", "cc": "", "city": "", "lat": None, "lon": None, "isp": "", "asn": "", "ts": time.time()}
                    self.cache[ip] = row
                    rows.append(tuple(row[k] for k in ("ip", "country", "cc", "city", "lat", "lon", "isp", "asn", "ts")))
                self.db.xmany("INSERT OR REPLACE INTO geo VALUES (?,?,?,?,?,?,?,?,?)", rows)
                with self.lock:
                    self.pending -= set(batch)
                self.last_error = ""
                time.sleep(4.5)  # bepul limit: daqiqasiga 15 ta batch so'rov
            except Exception as e:
                self.last_error = str(getattr(e, "reason", e))
                time.sleep(30)


# --------------------------------------------------------------------------- security analysis

SAFE_ROOT = ("no", "prohibit-password", "without-password", "forced-commands-only")


def security_checks(snap):
    """Server xavfsizligi bo'yicha tekshiruvlar: [{key, label, state: ok|warn|crit|unknown, detail}]."""
    sec = snap.get("security") if snap and isinstance(snap.get("security"), dict) else None
    if not sec or sec.get("error"):
        return [{"key": "agent", "label": "Agent eski versiya", "state": "unknown",
                 "detail": "Xavfsizlik tekshiruvi uchun agentni yangilang (install.sh ni qayta ishga tushiring)"}]
    out = []
    f2b = sec.get("fail2ban") or {}
    jails = [j["name"] for j in f2b.get("jails", [])]
    if f2b.get("running") and any("ssh" in j for j in jails):
        banned = sum(j.get("banned", 0) for j in f2b["jails"])
        out.append({"key": "fail2ban", "label": "fail2ban", "state": "ok", "detail": "ishlayapti, hozir %d ta IP bloklangan" % banned})
    elif f2b.get("running"):
        out.append({"key": "fail2ban", "label": "fail2ban", "state": "warn", "detail": "ishlayapti, lekin sshd jail yoqilmagan"})
    else:
        out.append({"key": "fail2ban", "label": "fail2ban", "state": "crit",
                    "detail": "o'rnatilgan, lekin ishlamayapti" if f2b.get("installed") else "o'rnatilmagan — brute-force hujumlar bloklanmayapti"})
    ssh = sec.get("ssh") or {}
    if ssh.get("known"):
        pw = ssh.get("password_auth") or ssh.get("kbd_auth")
        out.append({"key": "password", "label": "SSH parol bilan kirish", "state": "crit" if pw else "ok",
                    "detail": "yoqilgan — parolni taxmin qilib kirish mumkin" if pw else "o'chirilgan, faqat kalit (key) bilan"})
        root = ssh.get("root_login", "yes")
        out.append({"key": "root", "label": "Root login", "state": "ok" if root in SAFE_ROOT else "warn",
                    "detail": "PermitRootLogin %s" % root})
        out.append({"key": "port", "label": "SSH porti", "state": "ok", "detail": str(ssh.get("port", "22"))})
    else:
        out.append({"key": "password", "label": "SSH sozlamasi", "state": "unknown", "detail": "sshd -T o'qilmadi (agent root emas?)"})
    fw = sec.get("firewall") or {}
    out.append({"key": "firewall", "label": "Firewall", "state": "ok" if fw.get("active") else "warn",
                "detail": ("%s yoqilgan" % fw.get("tool")) if fw.get("active") else "yoqilmagan"})
    out.append({"key": "agent", "label": "Agent porti", "state": "ok" if sec.get("agent_allow") else "warn",
                "detail": ("faqat %s ga ochiq" % ", ".join(sec["agent_allow"])) if sec.get("agent_allow")
                else "%s-port butun internetga ochiq (token bilan himoyalangan)" % sec.get("agent_port", 9800)})
    return out


def collect_attacks(servers, states, geo, only_sid=None):
    ips = {}
    srv_out = []
    totals = {"ssh": 0, "http": 0, "banned": 0}
    for srv in servers:
        if only_sid and srv["id"] != only_sid:
            continue
        st = states.get(srv["id"])
        snap = st.snapshot if st else None
        host_ip = srv["host"] if is_public(srv["host"]) else ((snap or {}).get("host") or {}).get("ip", "")
        g = geo.get(host_ip) if host_ip and is_public(host_ip) else None
        checks = security_checks(snap) if snap else []
        srv_out.append({"id": srv["id"], "name": srv["name"], "host": srv["host"], "status": st.status if st else "unknown",
                        "lat": g and g.get("lat"), "lon": g and g.get("lon"), "city": g and g.get("city"), "cc": g and g.get("cc"),
                        "checks": checks})
        if not snap:
            continue
        auth = snap.get("auth") if isinstance(snap.get("auth"), dict) else {}
        http = snap.get("http") if isinstance(snap.get("http"), dict) else {}
        sec = snap.get("security") if isinstance(snap.get("security"), dict) else {}
        banned = set()
        for j in ((sec.get("fail2ban") or {}).get("jails") or []):
            banned.update(j.get("ips") or [])
            totals["banned"] += j.get("banned", 0)

        def rec(ip):
            if ip not in ips:
                ips[ip] = {"ip": ip, "ssh": 0, "http": 0, "servers": [], "banned_on": [], "sample": ""}
            r = ips[ip]
            if srv["name"] not in r["servers"]:
                r["servers"].append(srv["name"])
            return r

        for a in auth.get("top_failed_ips") or []:
            r = rec(a["ip"])
            r["ssh"] += a["count"]
            totals["ssh"] += a["count"]
        for a in http.get("scanners") or []:
            r = rec(a["ip"])
            r["http"] += a["count"]
            r["sample"] = r["sample"] or a.get("sample", "")
            totals["http"] += a["count"]
        for ip in banned:
            r = rec(ip)
            if srv["name"] not in r["banned_on"]:
                r["banned_on"].append(srv["name"])
    rows = sorted(ips.values(), key=lambda r: r["ssh"] + r["http"], reverse=True)[:1500]
    countries = {}
    for r in rows:
        r["total"] = r["ssh"] + r["http"]
        g = geo.get(r["ip"]) or {}
        for k in ("country", "cc", "city", "lat", "lon", "isp", "asn"):
            r[k] = g.get(k)
        if r["cc"]:
            c = countries.setdefault(r["cc"], {"cc": r["cc"], "country": r["country"], "count": 0, "ips": 0})
            c["count"] += r["total"]
            c["ips"] += 1
    return {
        "ips": rows, "countries": sorted(countries.values(), key=lambda c: c["count"], reverse=True),
        "servers": srv_out, "totals": dict(totals, ips=len(rows), countries=len(countries)),
        "geo_pending": geo.pending_count(), "geo_enabled": geo.enabled, "geo_error": geo.last_error,
    }


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
        "forecast": st.forecast if st else None,
    }


def make_handler(db, mon, password, geo, ctx):
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
                res = api_ext.handle_get(self, ctx, p, parts, qs)
                if res:
                    return self._json(res[1], res[0])
                if p == "/api/servers":
                    return self._json(self.list_servers())
                if p == "/api/overview":
                    return self._json(self.overview())
                if p == "/api/events":
                    return self._json(self.events(qs))
                if p == "/api/attacks":
                    sid = (qs.get("server") or [None])[0]
                    servers = db.q("SELECT id, name, host FROM servers ORDER BY name")
                    return self._json(collect_attacks(servers, mon.states, geo, int(sid) if sid else None))
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
            try:
                res = api_ext.handle_post(self, ctx, p, parts, body)
            except ValueError:
                return self._json({"error": "noto'g'ri so'rov"}, 400)
            if res:
                return self._json(res[1], res[0])
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
            body = self._body()
            res = api_ext.handle_put(self, ctx, parts, body)
            if res:
                return self._json(res[1], res[0])
            if len(parts) == 3 and parts[:2] == ["api", "servers"]:
                return self.update_server(int(parts[2]), body)
            return self._json({"error": "topilmadi"}, 404)

        def do_DELETE(self):
            if not self._auth_ok():
                return
            parts = urlparse(self.path).path.strip("/").split("/")
            res = api_ext.handle_delete(self, ctx, parts)
            if res:
                return self._json(res[1], res[0])
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
            if not sid:
                return db.q("SELECT e.*, s.name AS server, t.name AS site FROM events e LEFT JOIN servers s ON s.id=e.server_id "
                            "LEFT JOIN sites t ON t.id=e.site_id ORDER BY e.ts DESC LIMIT ?", (limit,))
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
            row["checks"] = security_checks(st.snapshot) if st and st.snapshot else []
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
    ap.add_argument("--no-geoip", action="store_true",
                    help="hujumchi IP larining joylashuvini ip-api.com dan so'ramaslik (xarita ishlamaydi)")
    ap.add_argument("--password", default=os.environ.get("NETADMIN_DASHBOARD_PASSWORD", ""),
                    help="dashboardga kirish paroli (0.0.0.0 da ochsangiz tavsiya etiladi)")
    args = ap.parse_args()

    db = DB(args.db)
    mon = Monitor(db, args.interval, args.store_every, args.retention_days, args.timeout)
    geo = GeoIP(db, enabled=not args.no_geoip)
    mon.geo = geo
    notifier = notify.Notifier(db)
    mon.hooks.append(notifier.on_event)
    site_mon = sitesmod.SiteMonitor(db, mon, args.retention_days * 86400)
    ctx = api_ext.Ctx(db, mon, geo, site_mon, notifier, Installer(db, mon), digitalocean.DigitalOcean(db))
    notifier.report_builder = lambda: api_ext.build_report(ctx)
    threading.Thread(target=mon.run, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(db, mon, args.password, geo, ctx))
    httpd.daemon_threads = True
    print("NetAdmin Monitor: http://%s:%d" % ("127.0.0.1" if args.host == "0.0.0.0" else args.host, args.port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
