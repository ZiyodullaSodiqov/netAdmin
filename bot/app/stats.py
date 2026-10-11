"""Admin panel uchun statistika so'rovlari."""
from __future__ import annotations

from datetime import datetime, timedelta

from .config import config
from .db import DB, iso, now_utc

PAID = "('paid', 'delivered')"
PERIODS = {"today": "Bugun", "7d": "7 kun", "30d": "30 kun", "all": "Hammasi"}


def since(period: str) -> str:
    """Davr boshlanishi (UTC ISO). 'today' — mahalliy vaqt bo'yicha bugun 00:00."""
    now = now_utc()
    if period == "today":
        local = now.astimezone(config.tz)
        start = datetime(local.year, local.month, local.day, tzinfo=config.tz)
    elif period == "7d":
        start = now - timedelta(days=7)
    elif period == "30d":
        start = now - timedelta(days=30)
    else:
        start = datetime(2000, 1, 1, tzinfo=now.tzinfo)
    return iso(start)


async def overview(db: DB, period: str) -> dict:
    t = since(period)
    users = await db._one("SELECT COUNT(*) n FROM users")
    new_users = await db._one("SELECT COUNT(*) n FROM users WHERE created_at >= ?", (t,))
    active = await db._one("SELECT COUNT(DISTINCT user_id) n FROM events WHERE created_at >= ?", (t,))
    ev = {r["action"]: r for r in await db._all(
        "SELECT action, COUNT(*) n, COUNT(DISTINCT user_id) u FROM events WHERE created_at >= ? GROUP BY action",
        (t,))}
    rev = await db._one(
        f"SELECT COUNT(*) n, COALESCE(SUM(price + print_price * with_print), 0) s FROM orders "
        f"WHERE status IN {PAID} AND paid_at >= ?", (t,))
    waiting = await db._one("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting_payment'")
    return {"users": users["n"], "new_users": new_users["n"], "active": active["n"], "events": ev,
            "paid_orders": rev["n"], "revenue": rev["s"], "waiting": waiting["n"]}


async def attempts_by_service(db: DB, period: str) -> list[dict]:
    """Har xizmat bo'yicha: necha kishi kirgan, necha marta urungan (yaratgan), necha kishi sotib olgan."""
    t = since(period)
    rows = await db._all(
        "SELECT service, "
        " COUNT(DISTINCT CASE WHEN action='open' THEN user_id END) open_users, "
        " SUM(action='open') opens, "
        " COUNT(DISTINCT CASE WHEN action='generate' THEN user_id END) gen_users, "
        " SUM(action='generate') gens, "
        " SUM(action='error') errors, "
        " SUM(action='buy') buys, "
        " SUM(action='receipt_fail') receipt_fails, "
        " COUNT(DISTINCT CASE WHEN action='paid' THEN user_id END) paid_users, "
        " SUM(action='paid') paid "
        "FROM events WHERE created_at >= ? AND service IS NOT NULL GROUP BY service ORDER BY gens DESC, opens DESC",
        (t,))
    return rows


async def top_users(db: DB, period: str, limit: int = 20) -> list[dict]:
    t = since(period)
    return await db._all(
        "SELECT e.user_id, u.full_name, u.username, "
        " SUM(e.action='generate') gens, SUM(e.action='open') opens, SUM(e.action='paid') paid, "
        " (SELECT COALESCE(SUM(price + print_price * with_print), 0) FROM orders o "
        f"   WHERE o.user_id = e.user_id AND o.status IN {PAID}) spent, "
        " MAX(e.created_at) last_at "
        "FROM events e LEFT JOIN users u ON u.id = e.user_id "
        "WHERE e.created_at >= ? GROUP BY e.user_id ORDER BY gens DESC, opens DESC LIMIT ?", (t, limit))


async def user_detail(db: DB, uid: int) -> dict | None:
    u = await db.get_user(uid)
    if not u:
        return None
    per = await db._all(
        "SELECT service, SUM(action='open') opens, SUM(action='generate') gens, SUM(action='paid') paid "
        "FROM events WHERE user_id = ? AND service IS NOT NULL GROUP BY service ORDER BY gens DESC", (uid,))
    orders = await db._all("SELECT id, service, status, price, print_price, with_print, created_at FROM orders "
                           "WHERE user_id = ? ORDER BY id DESC LIMIT 10", (uid,))
    spent = await db._one(f"SELECT COALESCE(SUM(price + print_price * with_print), 0) s FROM orders "
                          f"WHERE user_id = ? AND status IN {PAID}", (uid,))
    return {"user": u, "per_service": per, "orders": orders, "spent": spent["s"]}
