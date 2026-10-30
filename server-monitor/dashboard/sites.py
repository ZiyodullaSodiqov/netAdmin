"""
Saytlar monitoringi: har bir URL ni tashqaridan (dashboard turgan kompyuterdan) tekshiradi —
ochiladimi, status kodi, javob vaqti, kalit so'z, SSL sertifikat muddati.
"""

import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

SSL_WARN_DAYS = (14, 7, 3, 1)
UA = "Mozilla/5.0 (NetAdminMonitor uptime check)"


def init_db(db):
    db.x("""CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
        interval INTEGER NOT NULL DEFAULT 60, keyword TEXT NOT NULL DEFAULT '', timeout REAL NOT NULL DEFAULT 10,
        grp TEXT NOT NULL DEFAULT '', created REAL NOT NULL)""")
    db.x("CREATE TABLE IF NOT EXISTS site_checks (site_id INTEGER NOT NULL, ts REAL NOT NULL, ok INTEGER NOT NULL, code INTEGER, ms REAL)")
    db.x("CREATE INDEX IF NOT EXISTS site_checks_idx ON site_checks(site_id, ts)")


def clean_url(url):
    url = (url or "").strip()
    if not url:
        raise ValueError("URL kiritilmagan")
    if "://" not in url:
        url = "https://" + url
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("URL noto'g'ri: %s" % url)
    return url


def ssl_info(host, port, timeout):
    """Sertifikat tugash vaqti va kim bergani. Tekshirish xatosi bo'lsa ham muddatni olishga harakat qiladi."""
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as s:
                cert = s.getpeercert()
        issuer = dict(x[0] for x in cert.get("issuer", ()))
        return {"expires": ssl.cert_time_to_seconds(cert["notAfter"]), "issuer": issuer.get("organizationName", ""),
                "valid": True, "error": ""}
    except ssl.SSLCertVerificationError as e:
        return {"expires": None, "issuer": "", "valid": False, "error": e.verify_message or str(e)}
    except Exception as e:
        return {"expires": None, "issuer": "", "valid": None, "error": str(e)}


class SiteState:
    def __init__(self):
        self.status = "unknown"  # up / down / unknown
        self.code = None
        self.ms = None
        self.error = ""
        self.last_check = 0
        self.fails = 0
        self.down_since = None
        self.ssl = None
        self.ssl_checked = 0
        self.ssl_warned = None
        self.ips = []
        self.history = []  # oxirgi 90 ta (ts, ok, ms)


class SiteMonitor:
    def __init__(self, db, monitor, retention):
        self.db = db
        self.mon = monitor
        self.retention = retention
        self.states = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=16)
        self.running = set()
        init_db(db)
        for r in db.q("SELECT site_id, ts, ok, ms FROM site_checks WHERE ts > ? ORDER BY ts", (time.time() - 6 * 3600,)):
            self.state(r["site_id"]).history.append((r["ts"], r["ok"], r["ms"]))
        for st in self.states.values():
            st.history = st.history[-90:]
        threading.Thread(target=self.run, daemon=True).start()

    def state(self, sid):
        with self.lock:
            if sid not in self.states:
                self.states[sid] = SiteState()
            return self.states[sid]

    def forget(self, sid):
        with self.lock:
            self.states.pop(sid, None)

    def run(self):
        last_prune = 0
        while True:
            now = time.time()
            for site in self.db.q("SELECT * FROM sites"):
                st = self.state(site["id"])
                if site["id"] not in self.running and now - st.last_check >= max(15, site["interval"]):
                    self.running.add(site["id"])
                    self.pool.submit(self._safe_check, site)
            if now - last_prune > 3600:
                last_prune = now
                self.db.x("DELETE FROM site_checks WHERE ts < ?", (now - self.retention,))
            time.sleep(3)

    def check_now(self, sid):
        site = self.db.q("SELECT * FROM sites WHERE id=?", (sid,), one=True)
        if site and sid not in self.running:
            self.running.add(sid)
            self.pool.submit(self._safe_check, site)

    def _safe_check(self, site):
        try:
            self.check(site)
        except Exception as e:
            print("sayt tekshiruv xatosi:", site.get("url"), e)
        finally:
            self.running.discard(site["id"])

    def check(self, site):
        st = self.state(site["id"])
        u = urlparse(site["url"])
        t0 = time.time()
        code, ok, err = None, False, ""
        try:
            st.ips = sorted(set(a[4][0] for a in socket.getaddrinfo(u.hostname, None)))
        except Exception:
            st.ips = []
        try:
            req = urllib.request.Request(site["url"], headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=site["timeout"] or 10) as r:
                code = r.status
                body = r.read(512 * 1024)
            ok = 200 <= code < 400
            if ok and site["keyword"]:
                if site["keyword"].encode() not in body:
                    ok, err = False, "sahifada \"%s\" so'zi topilmadi" % site["keyword"]
        except urllib.error.HTTPError as e:
            code, err = e.code, "HTTP %d %s" % (e.code, e.reason)
        except urllib.error.URLError as e:
            reason = e.reason
            if isinstance(reason, ssl.SSLCertVerificationError):
                err = "SSL sertifikat xatosi: %s" % (reason.verify_message or reason)
                if "local issuer" in str(reason):
                    err += " (Mac'da python.org Python bo'lsa: 'Install Certificates.command' ni ishga tushiring)"
            elif isinstance(reason, socket.timeout) or "timed out" in str(reason):
                err = "javob kelmadi (%ds timeout)" % (site["timeout"] or 10)
            elif isinstance(reason, socket.gaierror):
                err = "domen topilmadi (DNS)"
            elif isinstance(reason, ConnectionRefusedError):
                err = "ulanish rad etildi (port yopiq / nginx ishlamayapti)"
            else:
                err = "ulanib bo'lmadi: %s" % reason
        except (socket.timeout, TimeoutError):
            err = "javob kelmadi (%ds timeout)" % (site["timeout"] or 10)
        except Exception as e:
            err = str(e)
        ms = round((time.time() - t0) * 1000, 1)
        now = time.time()

        st.code, st.ms, st.error, st.last_check = code, (ms if code else None), err, now
        st.history = (st.history + [(now, int(ok), ms if code else None)])[-90:]
        self.db.x("INSERT INTO site_checks(site_id, ts, ok, code, ms) VALUES (?,?,?,?,?)", (site["id"], now, int(ok), code, ms if code else None))

        name = site["name"]
        if ok:
            if st.status == "down":
                dur = now - (st.down_since or now)
                self.mon.event(None, "ok", "site_up", "Sayt yana ishlayapti: %s (%s ishlamadi)" % (name, fmt_dur(dur)), site_id=site["id"])
            st.status, st.fails, st.down_since = "up", 0, None
        else:
            st.fails += 1
            if st.fails == 1:
                st.down_since = now
            if st.fails >= 2 and st.status != "down":  # bitta tasodifiy xato uchun ogohlantirmaymiz
                st.status = "down"
                hint = self.server_hint(st)
                self.mon.event(None, "crit", "site_down", "Sayt ishlamayapti: %s — %s%s" % (name, err, hint), site_id=site["id"])
            elif st.status == "unknown" and st.fails >= 2:
                st.status = "down"

        if u.scheme == "https" and now - st.ssl_checked > 6 * 3600:
            st.ssl_checked = now
            st.ssl = ssl_info(u.hostname, u.port or 443, site["timeout"] or 10)
            exp = st.ssl.get("expires")
            if exp:
                days = (exp - now) / 86400
                lvl = next((d for d in SSL_WARN_DAYS[::-1] if days <= d), None)
                if lvl is not None and st.ssl_warned != lvl:
                    st.ssl_warned = lvl
                    self.mon.event(None, "crit" if days <= 3 else "warn", "ssl",
                                   "SSL sertifikat tugayapti: %s — %d kun qoldi" % (name, max(0, int(days))), site_id=site["id"])
                elif lvl is None:
                    st.ssl_warned = None

    def server_hint(self, st):
        srv = self.linked_server(st)
        if srv and srv.get("status") == "online":
            return " (server %s ishlayapti — nginx yoki backend ni tekshiring)" % srv["name"]
        if srv and srv.get("status") == "offline":
            return " (server %s ham javob bermayapti)" % srv["name"]
        return ""

    def linked_server(self, st):
        """Domen IP si dashboarddagi qaysi serverga to'g'ri kelishi."""
        if not st.ips:
            return None
        for srv in self.db.q("SELECT id, name, host FROM servers"):
            sst = self.mon.states.get(srv["id"])
            ips = {srv["host"]}
            if sst and sst.snapshot:
                ips.add(((sst.snapshot.get("host") or {}).get("ip")) or "")
            if ips & set(st.ips):
                return {"id": srv["id"], "name": srv["name"], "status": sst.status if sst else "unknown"}
        return None

    def uptime(self, sid, since):
        r = self.db.q("SELECT COUNT(*) AS n, SUM(ok) AS ok, AVG(ms) AS ms FROM site_checks WHERE site_id=? AND ts>=?", (sid, since), one=True)
        if not r or not r["n"]:
            return None, None
        return round(100.0 * (r["ok"] or 0) / r["n"], 2), (round(r["ms"], 1) if r["ms"] is not None else None)

    def row(self, site):
        st = self.state(site["id"])
        now = time.time()
        up24, ms24 = self.uptime(site["id"], now - 86400)
        up7, _ = self.uptime(site["id"], now - 7 * 86400)
        ssl_ = st.ssl or {}
        return {
            "id": site["id"], "name": site["name"], "url": site["url"], "interval": site["interval"],
            "keyword": site["keyword"], "timeout": site["timeout"], "group": site["grp"],
            "status": st.status, "code": st.code, "ms": st.ms, "error": st.error, "last_check": st.last_check or None,
            "down_since": st.down_since if st.status == "down" else None,
            "uptime_24h": up24, "uptime_7d": up7, "avg_ms_24h": ms24,
            "ssl_expires": ssl_.get("expires"), "ssl_issuer": ssl_.get("issuer"), "ssl_valid": ssl_.get("valid"), "ssl_error": ssl_.get("error"),
            "ips": st.ips, "server": self.linked_server(st),
            "spark": [h[2] or 0 for h in st.history[-60:]], "spark_ok": [h[1] for h in st.history[-60:]],
        }


def fmt_dur(sec):
    sec = int(sec)
    if sec < 90:
        return "%d soniya" % sec
    if sec < 5400:
        return "%d daqiqa" % (sec // 60)
    if sec < 172800:
        return "%d soat" % (sec // 3600)
    return "%d kun" % (sec // 86400)
