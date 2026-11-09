"""Yozishmalar bazasi (data/archive.db).

Bu ma'lumotlar bot yoki web sahifada ko'rsatilmaydi — faqat bazaning o'zida turadi.
Agent undan faqat ichki tahlil (chat nima haqida, vazifalarni topish) uchun foydalanadi.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

from .timeutil import now_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    kind TEXT,              -- user | bot | group | supergroup | channel
    username TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    msg_id INTEGER NOT NULL,
    is_channel INTEGER NOT NULL DEFAULT 0,  -- supergroup/kanal (msg_id chat ichida noyob)
    sender_id INTEGER,
    sender_name TEXT,
    out INTEGER NOT NULL DEFAULT 0,          -- 1 = o'zim yozganman
    date TEXT,
    text TEXT,
    media_type TEXT,
    media_path TEXT,
    transcript TEXT,
    reply_to INTEGER,
    fwd_from TEXT,
    edited_at TEXT,
    deleted_at TEXT,
    saved_at TEXT NOT NULL,
    UNIQUE(chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_chat_date ON messages(chat_id, date);
CREATE INDEX IF NOT EXISTS idx_msg_msgid ON messages(msg_id);

CREATE TABLE IF NOT EXISTS message_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    msg_id INTEGER NOT NULL,
    old_text TEXT,
    new_text TEXT,
    edited_at TEXT NOT NULL
);
"""

MSG_COLS = ("chat_id", "msg_id", "is_channel", "sender_id", "sender_name", "out", "date", "text",
            "media_type", "media_path", "transcript", "reply_to", "fwd_from", "edited_at")


class MessageStore:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(SCHEMA)

    def q(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    def x(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, tuple(params))
            return cur.lastrowid or cur.rowcount

    # ---- chatlar ----
    def upsert_chat(self, chat_id: int, title: str | None, kind: str, username: str | None = None) -> None:
        self.x("INSERT INTO chats(chat_id,title,kind,username,updated_at) VALUES(?,?,?,?,?)"
               " ON CONFLICT(chat_id) DO UPDATE SET title=COALESCE(excluded.title, chats.title),"
               " kind=excluded.kind, username=COALESCE(excluded.username, chats.username),"
               " updated_at=excluded.updated_at",
               (chat_id, title, kind, username, now_db()))

    def chat(self, chat_id: int) -> dict | None:
        r = self.q("SELECT * FROM chats WHERE chat_id=?", (chat_id,))
        return r[0] if r else None

    def chats_by_activity(self, kinds: Iterable[str] | None = None, limit: int = 30) -> list[dict]:
        sql = ("SELECT c.*, MAX(m.date) AS last_date, COUNT(m.id) AS n FROM chats c"
               " JOIN messages m ON m.chat_id=c.chat_id")
        params: list[Any] = []
        if kinds:
            kinds = list(kinds)
            sql += f" WHERE c.kind IN ({','.join('?' for _ in kinds)})"
            params += kinds
        sql += " GROUP BY c.chat_id ORDER BY last_date DESC LIMIT ?"
        params.append(limit)
        return self.q(sql, params)

    # ---- xabarlar ----
    def save_message(self, **m: Any) -> None:
        data = {k: m.get(k) for k in MSG_COLS}
        data["is_channel"] = int(bool(data["is_channel"]))
        data["out"] = int(bool(data["out"]))
        data["saved_at"] = now_db()
        cols = ",".join(data)
        qs = ",".join("?" for _ in data)
        # Mavjud bo'lsa — matn va media yangilanadi, o'chirilganlik belgisi saqlanib qoladi.
        self.x(f"INSERT INTO messages({cols}) VALUES({qs}) ON CONFLICT(chat_id,msg_id) DO UPDATE SET"
               " text=COALESCE(excluded.text, messages.text),"
               " media_type=COALESCE(excluded.media_type, messages.media_type),"
               " media_path=COALESCE(excluded.media_path, messages.media_path),"
               " sender_name=COALESCE(excluded.sender_name, messages.sender_name)",
               data.values())

    def record_edit(self, chat_id: int, msg_id: int, new_text: str | None, edited_at: str | None) -> None:
        rows = self.q("SELECT text FROM messages WHERE chat_id=? AND msg_id=?", (chat_id, msg_id))
        old = rows[0]["text"] if rows else None
        if rows and old == new_text:
            return
        self.x("INSERT INTO message_edits(chat_id,msg_id,old_text,new_text,edited_at) VALUES(?,?,?,?,?)",
               (chat_id, msg_id, old, new_text, edited_at or now_db()))
        if rows:
            self.x("UPDATE messages SET text=?, edited_at=? WHERE chat_id=? AND msg_id=?",
                   (new_text, edited_at or now_db(), chat_id, msg_id))

    def mark_deleted(self, msg_ids: Iterable[int], channel_chat_id: int | None) -> int:
        """O'chirilgan xabarlarni belgilaydi (o'zi o'chirilmaydi).

        Shaxsiy chat va oddiy guruhlarda Telegram msg_id akkaunt bo'yicha noyob bo'ladi va chat_id
        kelmaydi; supergroup/kanalda esa chat_id keladi.
        """
        ids = list(msg_ids)
        if not ids:
            return 0
        now = now_db()
        qs = ",".join("?" for _ in ids)
        if channel_chat_id is not None:
            return self.x(f"UPDATE messages SET deleted_at=? WHERE deleted_at IS NULL AND chat_id=?"
                          f" AND msg_id IN ({qs})", [now, channel_chat_id, *ids])
        return self.x(f"UPDATE messages SET deleted_at=? WHERE deleted_at IS NULL AND is_channel=0"
                      f" AND msg_id IN ({qs})", [now, *ids])

    def set_transcript(self, chat_id: int, msg_id: int, transcript: str) -> None:
        self.x("UPDATE messages SET transcript=? WHERE chat_id=? AND msg_id=?", (transcript, chat_id, msg_id))

    def max_msg_id(self, chat_id: int) -> int:
        r = self.q("SELECT MAX(msg_id) AS m FROM messages WHERE chat_id=?", (chat_id,))
        return int(r[0]["m"] or 0) if r else 0

    def recent(self, chat_id: int, limit: int = 100, after_msg_id: int | None = None) -> list[dict]:
        sql = "SELECT * FROM messages WHERE chat_id=?"
        params: list[Any] = [chat_id]
        if after_msg_id is not None:
            sql += " AND msg_id>?"
            params.append(after_msg_id)
        sql += " ORDER BY msg_id DESC LIMIT ?"
        params.append(limit)
        return list(reversed(self.q(sql, params)))

    def chats_with_new_incoming(self, kinds: Iterable[str], positions: dict[int, int],
                                since: str) -> list[int]:
        kinds = list(kinds)
        rows = self.q(
            f"SELECT m.chat_id, MAX(m.msg_id) AS mx FROM messages m JOIN chats c ON c.chat_id=m.chat_id"
            f" WHERE m.out=0 AND m.date>=? AND c.kind IN ({','.join('?' for _ in kinds)})"
            f" GROUP BY m.chat_id", [since, *kinds])
        return [r["chat_id"] for r in rows if r["mx"] > positions.get(r["chat_id"], 0)]

    def find_chats(self, name: str, limit: int = 5) -> list[dict]:
        like = f"%{name.strip().lstrip('@')}%"
        return self.q("SELECT * FROM chats WHERE title LIKE ? OR username LIKE ? LIMIT ?", (like, like, limit))


def format_transcript(rows: list[dict], owner_label: str = "Men") -> str:
    """Xabarlar ro'yxatini AI uchun matnga aylantiradi."""
    lines = []
    for r in rows:
        who = owner_label if r.get("out") else (r.get("sender_name") or "?")
        body = r.get("text") or ""
        if r.get("transcript"):
            body = (body + " " if body else "") + f"[ovozli: {r['transcript']}]"
        elif r.get("media_type") and not body:
            body = f"[{r['media_type']}]"
        elif r.get("media_type"):
            body = f"[{r['media_type']}] {body}"
        date = (r.get("date") or "")[:16].replace("T", " ")
        lines.append(f"[{date}] {who}: {body}")
    return "\n".join(lines)
