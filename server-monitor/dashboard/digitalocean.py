"""
DigitalOcean integratsiyasi: dropletlar ro'yxati, oylik xarajat va RAM/CPU bo'yicha tavsiyalar.
Faqat o'qish (read-only) huquqli API token yetarli.
"""

import json
import math
import threading
import time
import urllib.error
import urllib.request

API = "https://api.digitalocean.com/v2/"


class DigitalOcean:
    def __init__(self, db):
        self.db = db
        self.cache = {}
        self.lock = threading.Lock()

    def token(self):
        return self.db.settings().get("do_token", "")

    def _get(self, path, token):
        req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise RuntimeError("DigitalOcean token noto'g'ri yoki muddati tugagan")
            try:
                msg = json.loads(e.read().decode()).get("message")
            except ValueError:
                msg = None
            raise RuntimeError("DigitalOcean API xatosi %d: %s" % (e.code, msg or e.reason))
        except urllib.error.URLError as e:
            raise RuntimeError("DigitalOcean ga ulanib bo'lmadi: %s" % e.reason)

    def _all(self, path, key, token):
        out, page = [], 1
        while True:
            sep = "&" if "?" in path else "?"
            data = self._get("%s%sper_page=200&page=%d" % (path, sep, page), token)
            out += data.get(key, [])
            if not ((data.get("links") or {}).get("pages") or {}).get("next") or page > 20:
                return out
            page += 1

    def fetch(self, force=False, token=None):
        token = token or self.token()
        if not token:
            return None
        with self.lock:
            c = self.cache.get(token)
            if c and not force and time.time() - c["t"] < 300:
                return c["data"]
        droplets = self._all("droplets", "droplets", token)
        sizes = self._all("sizes", "sizes", token)
        try:
            balance = self._get("customers/my/balance", token)
        except RuntimeError:
            balance = None  # read-only token billing ga ruxsat bermasligi mumkin
        data = {"droplets": droplets, "sizes": sizes, "balance": balance, "fetched": time.time()}
        with self.lock:
            self.cache[token] = {"t": time.time(), "data": data}
        return data


def public_ip(d):
    for n in ((d.get("networks") or {}).get("v4") or []):
        if n.get("type") == "public":
            return n.get("ip_address")
    return ""


def usage_stats(db, sid, days=7):
    """Oxirgi N kun: RAM va CPU ning 95-persentili, diskning maksimumi."""
    rows = db.q("SELECT mem, cpu, disk, swap FROM samples WHERE server_id=? AND ts>=? ORDER BY ts",
                (sid, time.time() - days * 86400))
    if len(rows) < 30:
        return None

    def p95(vals):
        vals = sorted(v or 0 for v in vals)
        return vals[min(len(vals) - 1, int(len(vals) * 0.95))]
    span = db.q("SELECT MIN(ts) AS a, MAX(ts) AS b FROM samples WHERE server_id=? AND ts>=?", (sid, time.time() - days * 86400), one=True)
    return {"mem_p95": round(p95(r["mem"] for r in rows), 1), "cpu_p95": round(p95(r["cpu"] for r in rows), 1),
            "disk_max": round(max(r["disk"] or 0 for r in rows), 1), "swap_p95": round(p95(r["swap"] for r in rows), 1),
            "hours": round(((span["b"] or 0) - (span["a"] or 0)) / 3600, 1)}


def recommend(d, usage, sizes):
    """Bitta droplet uchun tavsiya: kattalashtirish, kichraytirish yoki o'z holicha qoldirish."""
    if not usage:
        return {"kind": "none", "text": "Tavsiya uchun kamida bir necha soatlik monitoring ma'lumoti kerak"}
    mem_mb = d.get("memory", 0)
    used_mb = mem_mb * usage["mem_p95"] / 100.0
    price = (d.get("size") or {}).get("price_monthly", 0) or 0
    region = (d.get("region") or {}).get("slug")
    family = (d.get("size_slug") or "").split("-")[0]  # s- (Basic), c-, g-, m- ...
    avail = [s for s in sizes if s.get("available") and region in (s.get("regions") or []) and s["slug"].split("-")[0] == family]
    avail.sort(key=lambda s: (s.get("price_monthly", 0), s.get("memory", 0)))

    if usage["mem_p95"] >= 85 or usage["swap_p95"] >= 20 or usage["cpu_p95"] >= 85:
        need_mem = max(mem_mb + 1, used_mb * 1.4)
        need_cpu = d.get("vcpus", 1) + (1 if usage["cpu_p95"] >= 85 else 0)
        up = next((s for s in avail if s["memory"] >= need_mem and s["vcpus"] >= need_cpu), None)
        why = "RAM %.0f%%" % usage["mem_p95"] if usage["mem_p95"] >= 85 else ("swap %.0f%%" % usage["swap_p95"] if usage["swap_p95"] >= 20 else "CPU %.0f%%" % usage["cpu_p95"])
        if up:
            return {"kind": "up", "slug": up["slug"], "price": up["price_monthly"], "delta": round(up["price_monthly"] - price, 2),
                    "text": "Resurs yetishmayapti (%s). %s ga kattalashtiring: %s RAM, %d vCPU — oyiga +$%.0f. "
                            "'CPU and RAM only' tanlansa, keyin orqaga qaytarish mumkin."
                            % (why, up["slug"], fmt_mb(up["memory"]), up["vcpus"], up["price_monthly"] - price)}
        return {"kind": "up", "text": "Resurs yetishmayapti (%s) — kattaroq o'lchamga o'ting" % why}

    if usage["mem_p95"] <= 45 and usage["cpu_p95"] <= 40:
        need_mem = max(used_mb * 1.4, 400)
        need_cpu = max(1, int(math.ceil(d.get("vcpus", 1) * usage["cpu_p95"] / 100.0 * 1.5)))
        down = next((s for s in avail if s["memory"] >= need_mem and s["vcpus"] >= need_cpu and s["price_monthly"] < price), None)
        if down:
            note = ("DO diskni kichraytirmaydi: agar droplet avval 'CPU and RAM only' bilan kattalashtirilgan bo'lsa — Resize, "
                    "aks holda yangi kichik droplet ochib ko'chirish kerak.") if down.get("disk", 0) < d.get("disk", 0) else "Resize orqali o'tish mumkin."
            return {"kind": "down", "slug": down["slug"], "price": down["price_monthly"], "delta": round(down["price_monthly"] - price, 2),
                    "text": "Resurs ortiqcha (RAM %.0f%%, CPU %.0f%%). %s (%s RAM) yetadi — oyiga $%.0f tejaladi. %s"
                            % (usage["mem_p95"], usage["cpu_p95"], down["slug"], fmt_mb(down["memory"]), price - down["price_monthly"], note)}
    return {"kind": "ok", "text": "O'lcham to'g'ri tanlangan (RAM %.0f%%, CPU %.0f%%)" % (usage["mem_p95"], usage["cpu_p95"])}


def consolidation(items, sizes):
    """Kam yuklangan dropletlarni bitta kattaroq dropletga birlashtirish hisobi."""
    low = [i for i in items if i["usage"] and i["usage"]["mem_p95"] <= 60 and i["usage"]["cpu_p95"] <= 50]
    if len(low) < 2:
        return None
    by_region = {}
    for i in low:
        by_region.setdefault(i["region"], []).append(i)
    region, group = max(by_region.items(), key=lambda kv: len(kv[1]))
    if len(group) < 2:
        return None
    os_overhead = 180  # har bir alohida Ubuntu taxminan shuncha RAM oladi
    used = sum(i["memory"] * i["usage"]["mem_p95"] / 100.0 - os_overhead for i in group) + os_overhead
    used = max(used, 300)
    disk = sum(i["usage"]["disk_max"] / 100.0 * i["disk"] for i in group)
    cost = sum(i["price"] for i in group)
    cand = sorted((s for s in sizes if s.get("available") and region in (s.get("regions") or []) and s["slug"].startswith("s-")
                   and s["memory"] >= used * 1.5 and s["disk"] >= disk * 1.3), key=lambda s: s["price_monthly"])
    if not cand or cand[0]["price_monthly"] >= cost:
        return None
    s = cand[0]
    return {"region": region, "names": [i["name"] for i in group], "count": len(group), "used_mb": round(used),
            "cost": round(cost, 2), "slug": s["slug"], "memory": s["memory"], "vcpus": s["vcpus"], "disk": s["disk"],
            "price": s["price_monthly"], "save": round(cost - s["price_monthly"], 2)}


def fmt_mb(mb):
    return ("%g GB" % (mb / 1024.0)) if mb >= 1024 else ("%d MB" % mb)
