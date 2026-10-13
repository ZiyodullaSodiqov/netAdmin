"""SQLite ma'lumotlar bazasi (aiosqlite)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from .config import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    full_name TEXT,
    free_math_used INTEGER NOT NULL DEFAULT 0,
    math_credits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    service TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    price INTEGER NOT NULL DEFAULT 0,
    print_price INTEGER NOT NULL DEFAULT 0,
    with_print INTEGER NOT NULL DEFAULT 0,
    result_path TEXT,
    receipt_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
);
-- Karta xabarlari boti yuborgan kirimlar
CREATE TABLE IF NOT EXISTS card_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    card_last4 TEXT,
    raw TEXT NOT NULL,
    tg_msg_id INTEGER UNIQUE,
    order_id INTEGER,
    created_at TEXT NOT NULL
);
-- Foydalanuvchi harakatlari (admin panel statistikasi uchun)
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    service TEXT,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
-- Takliflar va adminga murojaatlar
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,              -- suggestion | contact
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',  -- new | read | answered
    answer TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
);
-- Web paneldan o'zgartiriladigan sozlamalar (masalan, majburiy kanallar)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Natijalarni brauzerda ko'rish uchun vaqtinchalik havolalar
CREATE TABLE IF NOT EXISTS preview_links (
    token TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
);
-- Bir chekni ikki marta ishlatib bo'lmasligi uchun
CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    paid_at TEXT,
    created_at TEXT NOT NULL
);
"""


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


class DB:
    def __init__(self, path: str | None = None):
        self.path = path or config.db_path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.conn = await aiosqlite.connect(self.path, isolation_level=None)  # autocommit; tranzaksiyalar qo'lda
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    async def _one(self, sql: str, args: tuple = ()) -> dict | None:
        async with self.conn.execute(sql, args) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None

    async def _all(self, sql: str, args: tuple = ()) -> list[dict]:
        async with self.conn.execute(sql, args) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def _exec(self, sql: str, args: tuple = ()) -> int:
        cur = await self.conn.execute(sql, args)
        await self.conn.commit()
        return cur.lastrowid

    # --- users ---
    async def upsert_user(self, uid: int, username: str | None, full_name: str) -> dict:
        await self._exec(
            "INSERT INTO users(id, username, full_name, created_at) VALUES(?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name",
            (uid, username, full_name, iso(now_utc())),
        )
        return await self.get_user(uid)

    async def get_user(self, uid: int) -> dict | None:
        return await self._one("SELECT * FROM users WHERE id=?", (uid,))

    async def use_math(self, uid: int) -> str | None:
        """Bitta misol yechish huquqini sarflaydi. Qaytaradi: 'free' | 'credit' | None (huquq yo'q)."""
        u = await self.get_user(uid)
        if u and not u["free_math_used"]:
            await self._exec("UPDATE users SET free_math_used=1 WHERE id=?", (uid,))
            return "free"
        cur = await self.conn.execute(
            "UPDATE users SET math_credits=math_credits-1 WHERE id=? AND math_credits>0", (uid,))
        await self.conn.commit()
        return "credit" if cur.rowcount else None

    async def refund_math(self, uid: int, how: str) -> None:
        if how == "free":
            await self._exec("UPDATE users SET free_math_used=0 WHERE id=?", (uid,))
        elif how == "credit":
            await self._exec("UPDATE users SET math_credits=math_credits+1 WHERE id=?", (uid,))

    async def add_math_credits(self, uid: int, n: int) -> None:
        await self._exec("UPDATE users SET math_credits=math_credits+? WHERE id=?", (n, uid))

    async def log_event(self, uid: int, action: str, service: str | None = None) -> None:
        await self._exec("INSERT INTO events(user_id, service, action, created_at) VALUES(?,?,?,?)",
                         (uid, service, action, iso(now_utc())))

    async def all_user_ids(self) -> list[int]:
        return [r["id"] for r in await self._all("SELECT id FROM users")]

    # --- takliflar / murojaatlar ---
    async def add_message(self, uid: int, kind: str, text: str) -> int:
        return await self._exec("INSERT INTO messages(user_id, kind, text, created_at) VALUES(?,?,?,?)",
                                (uid, kind, text, iso(now_utc())))

    async def get_message(self, mid: int) -> dict | None:
        return await self._one("SELECT * FROM messages WHERE id=?", (mid,))

    async def list_messages(self, kind: str | None = None, status: str | None = None, limit: int = 100) -> list[dict]:
        sql = ("SELECT m.*, u.full_name, u.username FROM messages m LEFT JOIN users u ON u.id = m.user_id "
               "WHERE (? IS NULL OR m.kind = ?) AND (? IS NULL OR m.status = ?) ORDER BY m.id DESC LIMIT ?")
        return await self._all(sql, (kind, kind, status, status, limit))

    async def set_message_status(self, mid: int, status: str, answer: str | None = None) -> None:
        if answer is not None:
            await self._exec("UPDATE messages SET status=?, answer=?, answered_at=? WHERE id=?",
                             (status, answer, iso(now_utc()), mid))
        else:
            await self._exec("UPDATE messages SET status=? WHERE id=?", (status, mid))

    async def count_new_messages(self) -> dict:
        rows = await self._all("SELECT kind, COUNT(*) n FROM messages WHERE status='new' GROUP BY kind")
        return {r["kind"]: r["n"] for r in rows}

    # --- ko'rish havolalari ---
    async def create_preview_link(self, order_id: int, ttl_hours: int) -> str:
        import secrets
        from datetime import timedelta
        token = secrets.token_urlsafe(24)
        await self._exec("DELETE FROM preview_links WHERE order_id=? OR expires_at < ?", (order_id, iso(now_utc())))
        await self._exec("INSERT INTO preview_links(token, order_id, expires_at) VALUES(?,?,?)",
                         (token, order_id, iso(now_utc() + timedelta(hours=ttl_hours))))
        return token

    async def preview_order(self, token: str) -> dict | None:
        r = await self._one("SELECT order_id FROM preview_links WHERE token=? AND expires_at > ?",
                            (token, iso(now_utc())))
        return await self.get_order(r["order_id"]) if r else None

    # --- sozlamalar ---
    async def get_setting(self, key: str) -> str | None:
        r = await self._one("SELECT value FROM settings WHERE key=?", (key,))
        return r["value"] if r else None

    async def set_setting(self, key: str, value: str) -> None:
        await self._exec("INSERT INTO settings(key, value) VALUES(?,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    # --- orders ---
    async def create_order(self, uid: int, service: str, params: dict, price: int, print_price: int) -> int:
        return await self._exec(
            "INSERT INTO orders(user_id, service, params, price, print_price, created_at) VALUES(?,?,?,?,?,?)",
            (uid, service, json.dumps(params, ensure_ascii=False), price, print_price, iso(now_utc())),
        )

    async def get_order(self, oid: int) -> dict | None:
        o = await self._one("SELECT * FROM orders WHERE id=?", (oid,))
        if o:
            o["params"] = json.loads(o["params"])
        return o

    async def update_order(self, oid: int, **fields: Any) -> None:
        if "params" in fields:
            fields["params"] = json.dumps(fields["params"], ensure_ascii=False)
        cols = ", ".join(f"{k}=?" for k in fields)
        await self._exec(f"UPDATE orders SET {cols} WHERE id=?", (*fields.values(), oid))

    async def awaiting_orders(self, uid: int) -> list[dict]:
        return await self._all(
            "SELECT * FROM orders WHERE user_id=? AND status='awaiting_payment' ORDER BY id DESC", (uid,))

    # --- payments ---
    async def add_card_payment(self, amount: int, paid_at: datetime, card_last4: str | None,
                               raw: str, tg_msg_id: int | None) -> int | None:
        try:
            return await self._exec(
                "INSERT INTO card_payments(amount, paid_at, card_last4, raw, tg_msg_id, created_at) "
                "VALUES(?,?,?,?,?,?)",
                (amount, iso(paid_at), card_last4, raw, tg_msg_id, iso(now_utc())),
            )
        except aiosqlite.IntegrityError:
            return None  # shu xabar allaqachon saqlangan

    async def free_card_payments(self, amount: int) -> list[dict]:
        return await self._all(
            "SELECT * FROM card_payments WHERE order_id IS NULL AND amount=? ORDER BY paid_at", (amount,))

    async def receipt_exists(self, receipt_id: str) -> bool:
        return await self._one("SELECT 1 FROM receipts WHERE receipt_id=?", (receipt_id,)) is not None

    async def confirm_payment(self, order_id: int, card_payment_id: int | None, receipt_id: str | None,
                              amount: int, paid_at: datetime | None) -> bool:
        """Atomar: chekni band qiladi, karta kirimini buyurtmaga bog'laydi, buyurtmani 'paid' qiladi."""
        try:
            await self.conn.execute("BEGIN IMMEDIATE")
            if receipt_id:
                await self.conn.execute(
                    "INSERT INTO receipts(receipt_id, order_id, amount, paid_at, created_at) VALUES(?,?,?,?,?)",
                    (receipt_id, order_id, amount, iso(paid_at) if paid_at else None, iso(now_utc())))
            if card_payment_id:
                cur = await self.conn.execute(
                    "UPDATE card_payments SET order_id=? WHERE id=? AND order_id IS NULL",
                    (order_id, card_payment_id))
                if cur.rowcount == 0:
                    raise aiosqlite.IntegrityError("card payment already used")
            cur = await self.conn.execute(
                "UPDATE orders SET status='paid', paid_at=?, receipt_id=? WHERE id=? AND status='awaiting_payment'",
                (iso(now_utc()), receipt_id, order_id))
            if cur.rowcount == 0:
                raise aiosqlite.IntegrityError("order not awaiting payment")
            await self.conn.commit()
            return True
        except aiosqlite.IntegrityError:
            await self.conn.rollback()
            return False


db = DB()
