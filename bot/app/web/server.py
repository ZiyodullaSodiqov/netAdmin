"""Web admin panel (aiohttp). Bot bilan bitta jarayonda ishlaydi: python main.py.

Kirish — WEB_ADMIN_PASSWORD; sessiya imzolangan cookie'da, barcha POST so'rovlar CSRF token bilan himoyalangan.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import logging
import time
from datetime import datetime
from urllib.parse import quote

from aiogram import Bot
from aiohttp import web

from .. import stats
from ..admin_actions import KIND_TITLE, approve_order, broadcast, reject_order, reply_message
from ..channels import get_channels, normalize, set_channels
from ..config import config
from ..db import db
from ..delivery import order_total
from ..services import SERVICES, fmt_sum
from .layout import card, login_page, page, post_button, table, tabs

log = logging.getLogger(__name__)
e = html.escape

COOKIE = "adm_sid"
BOT = web.AppKey("bot", Bot)
BC = web.AppKey("bc", dict)
BC_TASK = web.AppKey("bc_task", asyncio.Task)
SESSION_TTL = 7 * 24 * 3600
STATUS = {"draft": ("Ko'rilgan, to'lanmagan", ""), "awaiting_payment": ("To'lov kutilmoqda", "warn"),
          "paid": ("To'langan", "ok"), "delivered": ("Yetkazilgan", "ok"), "rejected": ("Rad etilgan", "bad"),
          "cancelled": ("Bekor qilingan", "")}
MSG_STATUS = {"new": ("Yangi", "bad"), "read": ("O'qilgan", ""), "answered": ("Javob berilgan", "ok")}


# ---------- yordamchilar ----------

def _secret() -> bytes:
    base = config.web_secret or ("web:" + config.bot_token)
    return hashlib.sha256(base.encode()).digest()


def _sign(msg: str) -> str:
    return hmac.new(_secret(), msg.encode(), hashlib.sha256).hexdigest()


def _pw_tag() -> str:
    # Parol o'zgarsa, eski sessiyalar avtomatik bekor bo'ladi
    return hashlib.sha256(config.web_admin_password.encode()).hexdigest()[:16]


def make_session() -> str:
    exp = int(time.time()) + SESSION_TTL
    return f"{exp}.{_sign(f'{exp}:{_pw_tag()}')}"


def valid_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(f"{exp}:{_pw_tag()}"))


def csrf_for(req: web.Request) -> str:
    return _sign("csrf:" + (req.cookies.get(COOKIE) or ""))[:32]


def t(ts: str | None) -> str:
    """ISO (UTC) → mahalliy vaqt 'YYYY-MM-DD HH:MM'."""
    if not ts:
        return ""
    try:
        return datetime.fromisoformat(ts).astimezone(config.tz).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return ts[:16]


def svc_title(key: str | None) -> str:
    return SERVICES[key].title if key in SERVICES else (key or "—")


def badge(status: str, mapping: dict) -> str:
    label, cls = mapping.get(status, (status, ""))
    return f'<span class="badge {cls}">{e(label)}</span>'


def user_link(uid: int, name: str | None = None, username: str | None = None) -> str:
    label = e(name or str(uid)) + (f' <span class="muted">@{e(username)}</span>' if username else "")
    return f'<a href="/users/{uid}">{label}</a>'


def redirect(location: str, ok: str = "", err: str = "") -> web.HTTPFound:
    sep = "&" if "?" in location else "?"
    if ok:
        location += f"{sep}ok={quote(ok)}"
    elif err:
        location += f"{sep}err={quote(err)}"
    return web.HTTPFound(location)


async def counters() -> dict:
    new = await db.count_new_messages()
    waiting = await db._one("SELECT COUNT(*) n FROM orders WHERE status='awaiting_payment'")
    return {"/messages?kind=suggestion": new.get("suggestion", 0), "/messages?kind=contact": new.get("contact", 0),
            "/orders": waiting["n"]}


async def render(req: web.Request, title: str, body: str, active: str) -> web.Response:
    ok, err = req.query.get("ok", ""), req.query.get("err", "")
    return web.Response(text=page(title, body, active, await counters(), flash=ok or err, flash_bad=bool(err)),
                        content_type="text/html")


async def form(req: web.Request) -> dict:
    data = await req.post()
    if not hmac.compare_digest(str(data.get("csrf", "")), csrf_for(req)):
        raise web.HTTPForbidden(text="CSRF token noto'g'ri. Sahifani yangilab qayta urinib ko'ring.")
    return data


def period_of(req: web.Request) -> str:
    p = req.query.get("p", "today")
    return p if p in stats.PERIODS else "today"


def period_tabs(path: str, current: str) -> str:
    return tabs([(f"{path}?p={p}", t) for p, t in stats.PERIODS.items()], f"{path}?p={current}")


# ---------- kirish ----------

_attempts: dict[str, list[float]] = {}


@web.middleware
async def auth_mw(request: web.Request, handler):
    if request.path == "/login":
        return await handler(request)
    if not valid_session(request.cookies.get(COOKIE)):
        raise web.HTTPFound("/login")
    resp = await handler(request)
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    return resp


async def login_get(req: web.Request):
    return web.Response(text=login_page(), content_type="text/html")


async def login_post(req: web.Request):
    ip = req.remote or "?"
    now = time.time()
    recent = [t for t in _attempts.get(ip, []) if now - t < 600]
    if len(recent) >= 5:
        return web.Response(text=login_page("Juda ko'p urinish. 10 daqiqadan so'ng qayta urining."),
                            content_type="text/html", status=429)
    data = await req.post()
    if not hmac.compare_digest(str(data.get("password", "")).encode(), config.web_admin_password.encode()):
        recent.append(now)
        _attempts[ip] = recent
        await asyncio.sleep(1)
        return web.Response(text=login_page("Parol noto'g'ri"), content_type="text/html", status=401)
    _attempts.pop(ip, None)
    resp = web.HTTPFound("/")
    resp.set_cookie(COOKIE, make_session(), max_age=SESSION_TTL, httponly=True, samesite="Strict",
                    secure=req.secure)
    raise resp


async def logout(req: web.Request):
    resp = web.HTTPFound("/login")
    resp.del_cookie(COOKIE)
    raise resp


# ---------- statistika ----------

async def dashboard(req: web.Request):
    p = period_of(req)
    o = await stats.overview(db, p)
    ev = o["events"]

    def ev_val(a, k="n"):
        return ev[a][k] if a in ev else 0

    cards = "".join([
        card("Jami foydalanuvchilar", o["users"]), card("Yangi qo'shilgan", o["new_users"]),
        card("Faol foydalanuvchilar", o["active"]),
        card("Urinishlar (necha marta)", ev_val("generate")), card("Urinib ko'rgan (necha kishi)", ev_val("generate", "u")),
        card("To'langan buyurtmalar", o["paid_orders"]), card("Tushum", fmt_sum(o["revenue"])),
        card("To'lov kutilmoqda", o["waiting"]),
    ])
    days = await stats.daily(db, 14)
    mx = max([d["gens"] or 0 for d in days] + [1])
    drows = [[e(d["d"]), str(d["users"]), str(d["gens"] or 0), str(d["paid"] or 0),
              f'<div class="bar" style="width:{int(100 * (d["gens"] or 0) / mx)}%"></div>'] for d in reversed(days)]
    labels = {"start": "/start bosgan", "open": "Xizmatni ochgan", "generate": "Natija yaratgan (urinish)",
              "error": "Xatolik", "buy": "«Sotib olaman» bosgan", "receipt": "Chek yuborgan",
              "receipt_fail": "Chek rad etilgan", "paid": "To'lagan", "suggestion": "Taklif yuborgan",
              "contact": "Adminga yozgan"}
    erows = [[e(lbl), str(ev[a]["u"]), str(ev[a]["n"])] for a, lbl in labels.items() if a in ev]
    body = (period_tabs("/", p) + f'<div class="cards">{cards}</div>'
            + "<h2>Harakatlar</h2>" + table(["Harakat", "Necha kishi", "Necha marta"], erows, {1, 2})
            + "<h2>Oxirgi 14 kun</h2>"
            + table(["Sana", "Faol kishi", "Urinishlar", "To'lovlar", ""], drows, {1, 2, 3}))
    return await render(req, "Statistika", body, "/")


async def attempts(req: web.Request):
    p = period_of(req)
    rows = await stats.attempts_by_service(db, p)
    out = []
    for r in rows:
        conv = f"{round(100 * (r['paid_users'] or 0) / r['gen_users'])}%" if r["gen_users"] else "—"
        out.append([e(svc_title(r["service"])), str(r["open_users"] or 0), str(r["opens"] or 0),
                    str(r["gen_users"] or 0), str(r["gens"] or 0), str(r["errors"] or 0), str(r["buys"] or 0),
                    str(r["receipt_fails"] or 0), str(r["paid_users"] or 0), str(r["paid"] or 0), conv])
    body = (period_tabs("/attempts", p)
            + '<p class="muted">Har bir xizmat bo\'yicha: necha kishi kirgan va necha marta, necha kishi necha marta '
              "natija yaratgan (qayta yaratish ham urinish), necha kishi to'lagan.</p>"
            + table(["Xizmat", "Kirgan (kishi)", "Kirgan (marta)", "Uringan (kishi)", "Urinish (marta)", "Xato",
                     "Sotib olaman", "Rad chek", "To'lagan (kishi)", "To'lov (marta)", "Konversiya"],
                    out, set(range(1, 11))))
    return await render(req, "Urinishlar", body, "/attempts")


# ---------- foydalanuvchilar ----------

async def users(req: web.Request):
    q = req.query.get("q", "")
    rows = await stats.search_users(db, q, 100)
    out = [[user_link(r["id"], r["full_name"], r["username"]), f'<code>{r["id"]}</code>', str(r["opens"]),
            str(r["gens"]), str(r["paid"]), e(fmt_sum(r["spent"])), e(t(r["last_at"] or ""))]
           for r in rows]
    body = (f'<form class="row" method="get" action="/users" style="margin-bottom:14px;max-width:460px">'
            f'<input name="q" value="{e(q)}" placeholder="Ism, @username yoki ID"><button>Qidirish</button></form>'
            + table(["Foydalanuvchi", "ID", "Kirgan", "Urinish", "To'lagan", "Sarflagan", "Oxirgi faollik"],
                    out, {2, 3, 4, 5}))
    return await render(req, "Foydalanuvchilar", body, "/users")


async def user_detail(req: web.Request):
    uid = int(req.match_info["uid"])
    d = await stats.user_detail(db, uid)
    if not d:
        raise web.HTTPNotFound(text="Foydalanuvchi topilmadi")
    u = d["user"]
    cards = "".join([card("Jami to'lagan", fmt_sum(d["spent"])), card("Qo'shilgan", u["created_at"][:10]),
                     card("Misol kreditlari", u["math_credits"])])
    per = [[e(svc_title(r["service"])), str(r["opens"] or 0), str(r["gens"] or 0), str(r["paid"] or 0)]
           for r in d["per_service"]]
    orders = [[f'#{o["id"]}', e(svc_title(o["service"])), badge(o["status"], STATUS), e(fmt_sum(order_total(o))),
               e(t(o["created_at"]))] for o in d["orders"]]
    msgs = await db._all("SELECT * FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 20", (uid,))
    mrows = [[e(KIND_TITLE.get(m["kind"], m["kind"])), f'<div style="white-space:pre-wrap">{e(m["text"])}</div>',
              badge(m["status"], MSG_STATUS)] for m in msgs]
    uname = f' · <a href="https://t.me/{e(u["username"])}">@{e(u["username"])}</a>' if u["username"] else ""
    body = (f'<p class="muted">ID <code>{uid}</code>{uname}</p><div class="cards">{cards}</div>'
            + "<h2>Xizmatlar bo'yicha</h2>" + table(["Xizmat", "Kirgan", "Urinish", "To'lagan"], per, {1, 2, 3})
            + "<h2>Buyurtmalar</h2>" + table(["#", "Xizmat", "Holat", "Summa", "Sana"], orders)
            + "<h2>Takliflar va murojaatlar</h2>" + table(["Turi", "Matn", "Holat"], mrows)
            + f'<h2>Xabar yuborish</h2><form method="post" action="/users/{uid}/message" style="max-width:560px">'
              f'<input type="hidden" name="csrf" value="{e(csrf_for(req))}"><textarea name="text" required></textarea>'
              f'<p></p><button>Yuborish</button></form>')
    return await render(req, u["full_name"] or str(uid), body, "/users")


async def user_message(req: web.Request):
    uid = int(req.match_info["uid"])
    data = await form(req)
    text = str(data.get("text", "")).strip()
    if not text:
        raise redirect(f"/users/{uid}", err="Matn bo'sh")
    try:
        await req.app[BOT].send_message(uid, f"📩 <b>Admin xabari:</b>\n\n{e(text)}")
    except Exception:  # noqa: BLE001
        raise redirect(f"/users/{uid}", err="Yetib bormadi (foydalanuvchi botni bloklagan bo'lishi mumkin)")
    raise redirect(f"/users/{uid}", ok="Xabar yuborildi")


# ---------- buyurtmalar va to'lovlar ----------

ORDER_TABS = {"awaiting_payment": "To'lov kutilmoqda", "paid": "To'langan", "rejected": "Rad etilgan",
              "draft": "Ko'rilgan, to'lanmagan", "all": "Hammasi"}


async def orders(req: web.Request):
    st = req.query.get("status", "awaiting_payment")
    st = st if st in ORDER_TABS else "awaiting_payment"
    where = {"paid": "o.status IN ('paid','delivered')", "all": "1=1"}.get(st, "o.status = ?")
    args = () if st in ("paid", "all") else (st,)
    rows = await db._all(f"SELECT o.*, u.full_name, u.username FROM orders o LEFT JOIN users u ON u.id=o.user_id "
                         f"WHERE {where} ORDER BY o.id DESC LIMIT 200", args)
    csrf = csrf_for(req)
    out = []
    for o in rows:
        params = json.loads(o["params"] or "{}")
        pr = params.get("pending_receipt") or {}
        receipt = e(o["receipt_id"] or pr.get("id") or "—")
        extra = []
        if o["with_print"]:
            extra.append(f'🖨 tel: {e(params.get("phone", "—"))}')
        actions = ""
        if o["status"] == "awaiting_payment":
            actions = (post_button(f"/orders/{o['id']}/approve", "✅ Tasdiqlash", csrf,
                                   confirm=f"#{o['id']} to'lovini tasdiqlab, faylni yuborasizmi?") + " "
                       + post_button(f"/orders/{o['id']}/reject", "Rad etish", csrf, "sec",
                                     confirm=f"#{o['id']} ni rad etasizmi?"))
        out.append([f'#{o["id"]}', user_link(o["user_id"], o["full_name"], o["username"]),
                    e(svc_title(o["service"])) + (f'<br><span class="muted">{"; ".join(extra)}</span>' if extra else ""),
                    e(fmt_sum(o["price"] + (o["print_price"] if o["with_print"] else 0))), badge(o["status"], STATUS),
                    f"<code>{receipt}</code>", e(t(o["created_at"])), actions])
    body = (tabs([(f"/orders?status={k}", v) for k, v in ORDER_TABS.items()], f"/orders?status={st}")
            + table(["#", "Mijoz", "Xizmat", "Summa", "Holat", "Chek ID", "Sana", ""], out, {3}))
    return await render(req, "Buyurtmalar", body, "/orders")


async def order_action(req: web.Request):
    await form(req)
    oid, act = int(req.match_info["oid"]), req.match_info["act"]
    fn = approve_order if act == "approve" else reject_order
    ok, text = await fn(req.app[BOT], oid)
    raise redirect("/orders", ok=text) if ok else redirect("/orders", err=text)


async def payments(req: web.Request):
    rows = await db._all("SELECT * FROM card_payments ORDER BY id DESC LIMIT 200")
    out = [[f'#{r["id"]}', e(fmt_sum(r["amount"])), e(t(r["paid_at"])), e(r["card_last4"] or "—"),
            (f'<a href="/orders?status=all">#{r["order_id"]}</a>' if r["order_id"]
             else '<span class="badge warn">bog\'lanmagan</span>'),
            f'<span class="muted" style="white-space:pre-wrap">{e(r["raw"][:300])}</span>'] for r in rows]
    note = "" if config.tg_session_string else \
        '<div class="flash bad">Userbot sozlanmagan (TG_SESSION_STRING) — kirimlar avtomatik kelmaydi.</div>'
    body = note + table(["#", "Summa", "Vaqt", "Karta", "Buyurtma", "Xabar"], out, {1})
    return await render(req, "Karta kirimlari", body, "/payments")


# ---------- takliflar va murojaatlar ----------

async def messages(req: web.Request):
    kind = req.query.get("kind", "suggestion")
    kind = kind if kind in KIND_TITLE else "suggestion"
    st = req.query.get("status", "new")
    st = st if st in ("new", "answered", "read", "all") else "new"
    rows = await db.list_messages(kind, None if st == "all" else st, 200)
    csrf = csrf_for(req)
    items = []
    for m in rows:
        ans = f'<div class="ans">↪ {e(m["answer"])}</div>' if m["answer"] else ""
        mark = post_button(f"/messages/{m['id']}/read", "O'qildi", csrf, "sec") if m["status"] == "new" else ""
        items.append(
            f'<div class="msg"><div class="row" style="justify-content:space-between"><div>'
            f'<b>#M{m["id"]}</b> · {user_link(m["user_id"], m["full_name"], m["username"])} · '
            f'<span class="muted">{e(t(m["created_at"]))}</span></div>'
            f'{badge(m["status"], MSG_STATUS)}</div><div class="t">{e(m["text"])}</div>{ans}'
            f'<form method="post" action="/messages/{m["id"]}/reply" class="row">'
            f'<input type="hidden" name="csrf" value="{e(csrf)}">'
            f'<input name="text" placeholder="Javob yozing..." required style="flex:1;min-width:200px">'
            f'<button>Javob berish</button></form><div style="margin-top:6px">{mark}</div></div>')
    title = "Takliflar" if kind == "suggestion" else "Murojaatlar"
    st_tabs = tabs([(f"/messages?kind={kind}&status={s}", lbl) for s, lbl in
                    (("new", "Yangi"), ("answered", "Javob berilgan"), ("read", "O'qilgan"), ("all", "Hammasi"))],
                   f"/messages?kind={kind}&status={st}")
    body = st_tabs + ("".join(items) or '<p class="muted">Xabarlar yo\'q.</p>')
    return await render(req, title, body, f"/messages?kind={kind}")


async def message_reply(req: web.Request):
    data = await form(req)
    mid = int(req.match_info["mid"])
    m = await db.get_message(mid)
    back = f"/messages?kind={m['kind']}" if m else "/messages"
    text = str(data.get("text", "")).strip()
    if not text:
        raise redirect(back, err="Javob matni bo'sh")
    ok, msg = await reply_message(req.app[BOT], mid, text)
    raise redirect(back, ok=msg) if ok else redirect(back, err=msg)


async def message_read(req: web.Request):
    await form(req)
    mid = int(req.match_info["mid"])
    m = await db.get_message(mid)
    if m and m["status"] == "new":
        await db.set_message_status(mid, "read")
    raise redirect(f"/messages?kind={m['kind'] if m else 'suggestion'}", ok="Belgilandi")


# ---------- majburiy obuna ----------

async def channels(req: web.Request):
    bot: Bot = req.app[BOT]
    chs = await get_channels()
    me = await bot.me()
    rows = []
    for ch in chs:
        try:
            chat = await bot.get_chat(ch)
            member = await bot.get_chat_member(ch, me.id)
            is_admin = member.status in ("administrator", "creator")
            st = '<span class="badge ok">Bot admin ✓</span>' if is_admin else \
                '<span class="badge bad">Bot admin emas — obunani tekshira olmaydi</span>'
            title = e(chat.title or ch)
        except Exception:  # noqa: BLE001
            st, title = '<span class="badge bad">Topilmadi yoki bot kanalda yo\'q</span>', "—"
        rows.append([f"<code>{e(ch)}</code>", title, st])
    body = ('<p class="muted">Foydalanuvchi bu kanallarning barchasiga obuna bo\'lmaguncha bot ishlamaydi. '
            "Bot har bir kanalda <b>admin</b> bo'lishi shart. Ro'yxat bo'sh bo'lsa — majburiy obuna o'chiq.</p>"
            + table(["Kanal", "Nomi", "Holat"], rows, empty="Majburiy obuna o'chirilgan")
            + f'<h2>Kanallarni o\'zgartirish</h2><form method="post" action="/channels" style="max-width:520px">'
              f'<input type="hidden" name="csrf" value="{e(csrf_for(req))}">'
              f'<textarea name="channels" placeholder="@kanal1&#10;@kanal2">{e(chr(10).join(chs))}</textarea>'
              f'<p class="muted">Har qatorga bitta: @username, https://t.me/username yoki -100... ID</p>'
              f'<button>Saqlash</button></form>')
    return await render(req, "Majburiy obuna", body, "/channels")


async def channels_save(req: web.Request):
    data = await form(req)
    chs = normalize(str(data.get("channels", "")))
    await set_channels(chs)
    raise redirect("/channels", ok=f"Saqlandi: {len(chs)} ta kanal" if chs else "Majburiy obuna o'chirildi")


# ---------- xabar yuborish ----------

async def broadcast_page(req: web.Request):
    bc = req.app[BC]
    n = len(await db.all_user_ids())
    status = ""
    if bc["running"]:
        status = f'<div class="flash">Yuborilmoqda... {bc["done"]}/{bc["total"]} (sahifani yangilang)</div>'
    elif bc["total"]:
        status = (f'<div class="flash">Oxirgi yuborish: yetib bordi {bc["ok"]}, yetmadi {bc["fail"]} '
                  f'(jami {bc["total"]})</div>')
    body = (status + f'<p class="muted">Xabar barcha <b>{n}</b> foydalanuvchiga yuboriladi. '
            "HTML teglari: &lt;b&gt;qalin&lt;/b&gt;, &lt;i&gt;kursiv&lt;/i&gt;, &lt;a href=\"...\"&gt;havola&lt;/a&gt;.</p>"
            f'<form method="post" action="/broadcast" style="max-width:620px" '
            f'onsubmit="return confirm(\'Barcha foydalanuvchilarga yuborilsinmi?\')">'
            f'<input type="hidden" name="csrf" value="{e(csrf_for(req))}">'
            f'<textarea name="text" required style="min-height:160px"></textarea><p></p>'
            f'<button {"disabled" if bc["running"] else ""}>Yuborish</button></form>')
    return await render(req, "Xabar yuborish", body, "/broadcast")


async def broadcast_post(req: web.Request):
    data = await form(req)
    text = str(data.get("text", "")).strip()
    bc = req.app[BC]
    if not text:
        raise redirect("/broadcast", err="Matn bo'sh")
    if bc["running"]:
        raise redirect("/broadcast", err="Oldingi yuborish hali tugamagan")
    bot: Bot = req.app[BOT]
    ids = await db.all_user_ids()
    bc.update(running=True, total=len(ids), done=0, ok=0, fail=0)

    async def progress(i, n):
        bc["done"] = i

    async def run():
        try:
            ok, fail = await broadcast(bot, lambda uid: bot.send_message(uid, text), ids, progress)
            bc.update(ok=ok, fail=fail, done=len(ids))
        except Exception:  # noqa: BLE001
            log.exception("broadcast failed")
        finally:
            bc["running"] = False

    req.app[BC_TASK] = asyncio.create_task(run())
    raise redirect("/broadcast", ok="Yuborish boshlandi")


# ---------- ishga tushirish ----------

def create_app(bot: Bot) -> web.Application:
    app = web.Application(middlewares=[auth_mw], client_max_size=1024 ** 2)
    app[BOT] = bot
    app[BC] = {"running": False, "total": 0, "done": 0, "ok": 0, "fail": 0}
    app.add_routes([
        web.get("/login", login_get), web.post("/login", login_post), web.get("/logout", logout),
        web.get("/", dashboard), web.get("/attempts", attempts),
        web.get("/users", users), web.get(r"/users/{uid:-?\d+}", user_detail),
        web.post(r"/users/{uid:-?\d+}/message", user_message),
        web.get("/orders", orders), web.post(r"/orders/{oid:\d+}/{act:approve|reject}", order_action),
        web.get("/payments", payments),
        web.get("/messages", messages), web.post(r"/messages/{mid:\d+}/reply", message_reply),
        web.post(r"/messages/{mid:\d+}/read", message_read),
        web.get("/channels", channels), web.post("/channels", channels_save),
        web.get("/broadcast", broadcast_page), web.post("/broadcast", broadcast_post),
    ])
    return app


async def start_web(bot: Bot) -> web.AppRunner | None:
    if len(config.web_admin_password) < 8:
        log.warning("Web admin panel o'chiq: WEB_ADMIN_PASSWORD kamida 8 belgi bo'lishi kerak")
        return None
    runner = web.AppRunner(create_app(bot), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, config.web_host, config.web_port).start()
    log.info("Web admin panel: http://%s:%s", config.web_host, config.web_port)
    return runner
