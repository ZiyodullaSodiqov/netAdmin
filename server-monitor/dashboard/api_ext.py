"""
Qo'shimcha API: saytlar, sozlamalar (Telegram, DigitalOcean, SSH), SSH orqali o'rnatish,
DigitalOcean, loglar va haftalik hisobot.
"""

import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

import digitalocean
import notify
import sites as sitesmod


class Ctx:
    def __init__(self, db, mon, geo, sites, notifier, installer, do):
        self.db, self.mon, self.geo, self.sites = db, mon, geo, sites
        self.notifier, self.installer, self.do = notifier, installer, do


def hint(tok):
    return (tok[:4] + "…" + tok[-4:]) if tok and len(tok) > 10 else ("****" if tok else "")


# --------------------------------------------------------------------------- settings

def get_settings(ctx):
    s = ctx.db.settings()
    c = ctx.notifier.conf()
    return {
        "tg_token_set": bool(c["token"]), "tg_token_hint": hint(c["token"]), "tg_chat": c["chat"],
        "tg_kinds": c["kinds"], "event_kinds": [{"key": k, "label": l, "default": d} for k, l, d in notify.EVENT_KINDS],
        "tg_weekly": c["weekly"], "tg_weekly_day": c["weekly_day"], "tg_weekly_hour": c["weekly_hour"],
        "tg_last_error": ctx.notifier.last_error, "tg_sent": ctx.notifier.sent_count, "weekdays": notify.WEEKDAYS,
        "do_token_set": bool(s.get("do_token")), "do_token_hint": hint(s.get("do_token", "")),
        "ssh_user": s.get("ssh_user", "root"), "ssh_key": s.get("ssh_key", ""), "ssh_available": ctx.installer.available(),
    }


def save_settings(ctx, body):
    db = ctx.db
    for key in ("tg_token", "do_token"):
        if key in body and body[key] is not None:
            db.set_setting(key, str(body[key]).strip())
    if "tg_chat" in body:
        db.set_setting("tg_chat", str(body["tg_chat"]).strip())
    if "tg_kinds" in body and isinstance(body["tg_kinds"], list):
        valid = {k for k, _, _ in notify.EVENT_KINDS}
        db.set_setting("tg_kinds", json.dumps([k for k in body["tg_kinds"] if k in valid]))
    if "tg_weekly" in body:
        db.set_setting("tg_weekly", "1" if body["tg_weekly"] else "0")
    for key, lo, hi in (("tg_weekly_day", 0, 6), ("tg_weekly_hour", 0, 23)):
        if key in body:
            db.set_setting(key, str(max(lo, min(hi, int(body[key])))))
    if "ssh_user" in body:
        db.set_setting("ssh_user", str(body["ssh_user"]).strip() or "root")
    if "ssh_key" in body:
        db.set_setting("ssh_key", str(body["ssh_key"]).strip())
    return get_settings(ctx)


# --------------------------------------------------------------------------- weekly report

def build_report(ctx):
    db, mon = ctx.db, ctx.mon
    now = time.time()
    week = now - 7 * 86400
    servers = db.q("SELECT id, name FROM servers ORDER BY name")
    lines = ["📊 <b>Haftalik hisobot</b> — %s … %s" % (time.strftime("%d.%m", time.localtime(week)), time.strftime("%d.%m.%Y"))]

    online = sum(1 for s in servers if mon.states.get(s["id"]) and mon.states[s["id"]].status == "online")
    lines.append("\n🖥 <b>Serverlar:</b> %d ta (hozir ishlayapti: %d, o'chiq: %d)" % (len(servers), online, len(servers) - online))

    ups = []
    for s in servers:
        u = mon.uptime_pct(s["id"], 7)
        if u is not None:
            ups.append((u, s["name"]))
    if ups:
        ups.sort()
        avg = sum(u for u, _ in ups) / len(ups)
        lines.append("Uptime (7 kun): o'rtacha <b>%.2f%%</b>" % avg)
        for u, n in ups[:8]:
            if u < 99.99:
                lines.append("  • %s — %.2f%%" % (notify.esc(n), u))

    heavy = db.q("SELECT s.name, AVG(x.cpu) AS cpu, AVG(x.mem) AS mem, MAX(x.disk) AS disk FROM samples x "
                 "JOIN servers s ON s.id=x.server_id WHERE x.ts>=? GROUP BY x.server_id ORDER BY MAX(AVG(x.cpu), AVG(x.mem)) DESC LIMIT 5", (week,))
    if heavy:
        lines.append("\n🔥 <b>Eng yuklangan</b> (o'rtacha):")
        for h in heavy:
            lines.append("  • %s — CPU %.0f%%, RAM %.0f%%, disk maks %.0f%%" % (notify.esc(h["name"]), h["cpu"] or 0, h["mem"] or 0, h["disk"] or 0))

    disk_warn = []
    for s in servers:
        st = mon.states.get(s["id"])
        f = st.forecast if st else None
        if f and f.get("days") is not None and f["days"] <= 30:
            disk_warn.append("  • %s — ~%.0f kunda to'ladi (hozir %.0f%%)" % (notify.esc(s["name"]), f["days"], f["current"]))
        elif st and st.summary and st.summary.get("disk", 0) >= 85:
            disk_warn.append("  • %s — disk %.0f%%" % (notify.esc(s["name"]), st.summary["disk"]))
    if disk_warn:
        lines.append("\n💾 <b>Disk e'tibor talab qiladi:</b>")
        lines += disk_warn

    site_rows = [ctx.sites.row(r) for r in db.q("SELECT * FROM sites ORDER BY name")]
    if site_rows:
        lines.append("\n🌐 <b>Saytlar:</b> %d ta" % len(site_rows))
        for r in site_rows:
            ssl_days = int((r["ssl_expires"] - now) / 86400) if r.get("ssl_expires") else None
            extra = ", SSL %d kun" % ssl_days if ssl_days is not None and ssl_days <= 21 else ""
            ms = ", ~%d ms" % r["avg_ms_24h"] if r["avg_ms_24h"] else ""
            state = " — hozir ishlamayapti ❌" if r["status"] == "down" else ""
            lines.append("  • %s — %s uptime%s%s%s" % (notify.esc(r["name"]), "%.2f%%" % r["uptime_7d"] if r["uptime_7d"] is not None else "—",
                                                    ms, extra, state))

    ev = {r["kind"]: r["n"] for r in db.q("SELECT kind, COUNT(*) AS n FROM events WHERE ts>=? GROUP BY kind", (week,))}
    failed = 0
    for s in servers:
        st = mon.states.get(s["id"])
        if st and st.summary:
            failed += st.summary.get("failed_24h", 0) or 0
    lines.append("\n🛡 <b>Xavfsizlik:</b>")
    lines.append("  • SSH xato urinishlar (oxirgi 24 soat): %d" % failed)
    lines.append("  • Notanish IP dan kirishlar (7 kun): %d" % ev.get("login_new", 0))
    lines.append("\n📋 <b>Hodisalar (7 kun):</b> server o'chishi %d, sayt ishlamay qolishi %d, yuklama ogohlantirishi %d"
                 % (ev.get("offline", 0), ev.get("site_down", 0), ev.get("load", 0)))
    return "\n".join(lines)


# --------------------------------------------------------------------------- logs (agent proxy)

def server_logs(ctx, sid, qs):
    srv = ctx.db.q("SELECT host, port, token FROM servers WHERE id=?", (sid,), one=True)
    if not srv:
        return 404, {"error": "server topilmadi"}
    params = {k: (qs.get(k) or [""])[0] for k in ("source", "q", "n", "unit", "level")}
    host = srv["host"] if ":" not in srv["host"] else "[%s]" % srv["host"]
    url = "http://%s:%d/logs?%s" % (host, srv["port"], urlencode({k: v for k, v in params.items() if v}))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + srv["token"]})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 200, {"error": "Agent eski versiya — loglarni ko'rish uchun agentni yangilang (1.2.0+)", "old_agent": True}
        try:
            return 200, {"error": json.loads(e.read().decode()).get("error", "HTTP %d" % e.code)}
        except ValueError:
            return 200, {"error": "HTTP %d" % e.code}
    except Exception as e:
        return 200, {"error": "Agentga ulanib bo'lmadi: %s" % getattr(e, "reason", e)}


# --------------------------------------------------------------------------- DigitalOcean

def do_overview(ctx, refresh):
    token = ctx.do.token()
    if not token:
        return {"configured": False}
    try:
        data = ctx.do.fetch(force=refresh)
    except RuntimeError as e:
        return {"configured": True, "error": str(e)}
    servers = ctx.db.q("SELECT id, name, host FROM servers")
    by_ip = {}
    for s in servers:
        by_ip[s["host"]] = s
        st = ctx.mon.states.get(s["id"])
        if st and st.snapshot:
            ip = (st.snapshot.get("host") or {}).get("ip")
            if ip:
                by_ip.setdefault(ip, s)
    items = []
    for d in data["droplets"]:
        ip = digitalocean.public_ip(d)
        srv = by_ip.get(ip)
        st = ctx.mon.states.get(srv["id"]) if srv else None
        usage = digitalocean.usage_stats(ctx.db, srv["id"]) if srv else None
        size = d.get("size") or {}
        items.append({
            "id": d["id"], "name": d["name"], "ip": ip, "status": d.get("status"),
            "region": (d.get("region") or {}).get("slug"), "region_name": (d.get("region") or {}).get("name"),
            "size": d.get("size_slug"), "memory": d.get("memory", 0), "vcpus": d.get("vcpus", 0), "disk": d.get("disk", 0),
            "price": size.get("price_monthly", 0) or 0, "image": "%s %s" % ((d.get("image") or {}).get("distribution", ""), (d.get("image") or {}).get("name", "")),
            "tags": d.get("tags") or [], "created": d.get("created_at"),
            "server_id": srv["id"] if srv else None, "server_status": st.status if st else None,
            "summary": st.summary if st else None, "usage": usage,
            "rec": digitalocean.recommend(d, usage, data["sizes"]) if srv else None,
        })
    items.sort(key=lambda i: (i["server_id"] is None, i["name"]))
    bal = data.get("balance") or {}
    return {
        "configured": True, "droplets": items, "fetched": data["fetched"],
        "total_monthly": round(sum(i["price"] for i in items), 2),
        "month_to_date": bal.get("month_to_date_usage"), "account_balance": bal.get("account_balance"),
        "monitored": sum(1 for i in items if i["server_id"]),
        "savings": round(-sum(i["rec"]["delta"] for i in items if i["rec"] and i["rec"].get("kind") == "down" and i["rec"].get("delta")), 2),
        "consolidation": digitalocean.consolidation(items, data["sizes"]),
    }


# --------------------------------------------------------------------------- routing

def handle_get(h, ctx, p, parts, qs):
    """(status, obj) qaytaradi yoki None — bu modulga tegishli bo'lmasa."""
    if p == "/api/settings":
        return 200, get_settings(ctx)
    if p == "/api/sites":
        return 200, [ctx.sites.row(r) for r in ctx.db.q("SELECT * FROM sites ORDER BY grp, name")]
    if len(parts) == 3 and parts[:2] == ["api", "sites"]:
        r = ctx.db.q("SELECT * FROM sites WHERE id=?", (int(parts[2]),), one=True)
        if not r:
            return 404, {"error": "sayt topilmadi"}
        row = ctx.sites.row(r)
        row["events"] = ctx.db.q("SELECT * FROM events WHERE site_id=? ORDER BY ts DESC LIMIT 50", (r["id"],))
        return 200, row
    if len(parts) == 4 and parts[:2] == ["api", "sites"] and parts[3] == "history":
        sid, rng = int(parts[2]), max(900, min(int((qs.get("range") or ["86400"])[0]), 30 * 86400))
        raw = ctx.db.q("SELECT ts, ms, ok FROM site_checks WHERE site_id=? AND ts>=? ORDER BY ts", (sid, time.time() - rng))
        if len(raw) <= 400:  # tekshiruvlar kam bo'lsa — har birini o'zicha ko'rsatamiz
            return 200, {"range": rng, "points": [{"ts": r["ts"], "ms": r["ms"] or 0, "ok": r["ok"]} for r in raw]}
        bucket = max(60, rng // 300)
        rows = ctx.db.q("SELECT CAST(ts / ? AS INTEGER) * ? AS bts, AVG(ms) AS ms, MIN(ok) AS ok, COUNT(*) AS n FROM site_checks "
                        "WHERE site_id=? AND ts>=? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY bts", (bucket, bucket, sid, time.time() - rng, bucket))
        return 200, {"range": rng, "points": [{"ts": r["bts"], "ms": r["ms"] or 0, "ok": r["ok"]} for r in rows]}
    if p == "/api/install":
        return 200, sorted((j.as_dict() for j in ctx.installer.jobs.values()), key=lambda j: -j["started"])[:30]
    if len(parts) == 3 and parts[:2] == ["api", "install"]:
        j = ctx.installer.jobs.get(parts[2])
        return (200, j.as_dict()) if j else (404, {"error": "topilmadi"})
    if p == "/api/do":
        return 200, do_overview(ctx, bool((qs.get("refresh") or [""])[0]))
    if len(parts) == 4 and parts[:2] == ["api", "servers"] and parts[3] == "logs":
        return server_logs(ctx, int(parts[2]), qs)
    if p == "/api/report/preview":
        return 200, {"text": build_report(ctx)}
    return None


def handle_post(h, ctx, p, parts, body):
    if p == "/api/settings":
        return 200, save_settings(ctx, body)
    if p == "/api/telegram/test":
        token = (body.get("token") or "").strip() or None
        chat = (body.get("chat") or "").strip() or None
        try:
            ctx.notifier.send("✅ <b>NetAdmin Monitor</b> ulandi. Ogohlantirishlar shu yerga keladi.", token=token, chat=chat)
            return 200, {"ok": True}
        except Exception as e:
            return 200, {"ok": False, "error": str(e)}
    if p == "/api/telegram/chats":
        token = (body.get("token") or "").strip() or ctx.notifier.conf()["token"]
        if not token:
            return 200, {"error": "Avval bot tokenini kiriting"}
        try:
            return 200, {"chats": ctx.notifier.find_chats(token)}
        except Exception as e:
            return 200, {"error": str(e)}
    if p == "/api/report/send":
        try:
            ctx.notifier.send(build_report(ctx))
            return 200, {"ok": True}
        except Exception as e:
            return 200, {"ok": False, "error": str(e)}
    if p == "/api/sites":
        try:
            rec = clean_site(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        sid = ctx.db.x("INSERT INTO sites(name, url, interval, keyword, timeout, grp, created) VALUES (?,?,?,?,?,?,?)",
                       (rec["name"], rec["url"], rec["interval"], rec["keyword"], rec["timeout"], rec["grp"], time.time()))
        ctx.sites.check_now(sid)
        return 200, {"ok": True, "id": sid}
    if len(parts) == 4 and parts[:2] == ["api", "sites"] and parts[3] == "check":
        ctx.sites.check_now(int(parts[2]))
        return 200, {"ok": True}
    if p == "/api/install":
        try:
            params = ctx.installer.validate(body, ctx.db.settings())
            job = ctx.installer.start(params)
        except ValueError as e:
            return 400, {"error": str(e)}
        return 200, job.as_dict()
    return None


def handle_put(h, ctx, parts, body):
    if len(parts) == 3 and parts[:2] == ["api", "sites"]:
        try:
            rec = clean_site(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        ctx.db.x("UPDATE sites SET name=?, url=?, interval=?, keyword=?, timeout=?, grp=? WHERE id=?",
                 (rec["name"], rec["url"], rec["interval"], rec["keyword"], rec["timeout"], rec["grp"], int(parts[2])))
        ctx.sites.forget(int(parts[2]))
        ctx.sites.check_now(int(parts[2]))
        return 200, {"ok": True}
    return None


def handle_delete(h, ctx, parts):
    if len(parts) == 3 and parts[:2] == ["api", "sites"]:
        sid = int(parts[2])
        ctx.db.x("DELETE FROM sites WHERE id=?", (sid,))
        ctx.db.x("DELETE FROM site_checks WHERE site_id=?", (sid,))
        ctx.sites.forget(sid)
        return 200, {"ok": True}
    return None


def clean_site(body):
    url = sitesmod.clean_url(body.get("url"))
    try:
        interval = max(15, min(3600, int(body.get("interval") or 60)))
        timeout = max(2, min(60, float(body.get("timeout") or 10)))
    except (TypeError, ValueError):
        raise ValueError("Interval yoki timeout noto'g'ri")
    from urllib.parse import urlparse
    return {"url": url, "name": str(body.get("name") or "").strip() or urlparse(url).hostname, "interval": interval,
            "timeout": timeout, "keyword": str(body.get("keyword") or "").strip(), "grp": str(body.get("group") or "").strip()}
