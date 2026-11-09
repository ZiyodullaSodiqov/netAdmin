"""Asosiy baza: vazifalar, kontaktlar, hujjatlar, chat xulosalari, holat (kv)."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from .timeutil import from_db, now_db, to_db, utcnow

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | done | cancelled | suggested
    priority TEXT NOT NULL DEFAULT 'normal',     -- low | normal | high
    due_at TEXT,                                  -- UTC
    has_time INTEGER NOT NULL DEFAULT 0,
    no_deadline INTEGER NOT NULL DEFAULT 0,       -- egasi "muddatsiz" dedi
    assignee TEXT,                                -- kim bajaradi (NULL = o'zim)
    assignee_tg_id INTEGER,
    people TEXT NOT NULL DEFAULT '[]',            -- aloqador odamlar (JSON)
    source TEXT NOT NULL DEFAULT 'text',          -- text | voice | document | chat | web
    source_chat_id INTEGER,
    source_chat_title TEXT,
    snooze_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);

CREATE TABLE IF NOT EXISTS task_reminders (
    task_id INTEGER NOT NULL,
    offset_min INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (task_id, offset_min)
);

CREATE TABLE IF NOT EXISTS contacts (
    tg_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    phone TEXT,
    is_contact INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    mime TEXT,
    path TEXT,
    summary TEXT,
    content TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_summaries (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    summary TEXT,
    last_msg_id INTEGER,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_scan (
    chat_id INTEGER PRIMARY KEY,
    last_msg_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

TASK_FIELDS = (
    "title", "description", "status", "priority", "due_at", "has_time", "no_deadline",
    "assignee", "assignee_tg_id", "people", "source", "source_chat_id", "source_chat_title",
    "snooze_until", "completed_at",
)


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.executescript(SCHEMA)

    # ---- umumiy ----
    def q(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    def q1(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def x(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, tuple(params))
            return cur.lastrowid or cur.rowcount

    # ---- kv ----
    def get(self, key: str, default: str | None = None) -> str | None:
        r = self.q1("SELECT value FROM kv WHERE key=?", (key,))
        return r["value"] if r else default

    def set(self, key: str, value: str | None) -> None:
        if value is None:
            self.x("DELETE FROM kv WHERE key=?", (key,))
        else:
            self.x("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, value))

    def get_json(self, key: str, default: Any = None) -> Any:
        v = self.get(key)
        if v is None:
            return default
        try:
            return json.loads(v)
        except ValueError:
            return default

    def set_json(self, key: str, value: Any) -> None:
        self.set(key, None if value is None else json.dumps(value, ensure_ascii=False))

    # ---- vazifalar ----
    @staticmethod
    def _task_out(r: dict | None) -> dict | None:
        if r is None:
            return None
        try:
            r["people"] = json.loads(r.get("people") or "[]")
        except ValueError:
            r["people"] = []
        r["has_time"] = bool(r.get("has_time"))
        r["no_deadline"] = bool(r.get("no_deadline"))
        return r

    def add_task(self, **f: Any) -> dict:
        now = now_db()
        data = {k: f.get(k) for k in TASK_FIELDS if k in f}
        data.setdefault("status", "pending")
        if isinstance(data.get("people"), (list, tuple)):
            data["people"] = json.dumps(list(data["people"]), ensure_ascii=False)
        data["created_at"] = now
        data["updated_at"] = now
        cols = ",".join(data)
        qs = ",".join("?" for _ in data)
        tid = self.x(f"INSERT INTO tasks({cols}) VALUES({qs})", data.values())
        return self.get_task(tid)  # type: ignore[return-value]

    def get_task(self, tid: int) -> dict | None:
        return self._task_out(self.q1("SELECT * FROM tasks WHERE id=?", (tid,)))

    def update_task(self, tid: int, **f: Any) -> dict | None:
        old = self.get_task(tid)
        if old is None:
            return None
        data = {k: v for k, v in f.items() if k in TASK_FIELDS}
        if isinstance(data.get("people"), (list, tuple)):
            data["people"] = json.dumps(list(data["people"]), ensure_ascii=False)
        if "status" in data:
            if data["status"] == "done" and old["status"] != "done":
                data["completed_at"] = now_db()
            elif data["status"] != "done":
                data["completed_at"] = None
        if not data:
            return old
        data["updated_at"] = now_db()
        sets = ",".join(f"{k}=?" for k in data)
        self.x(f"UPDATE tasks SET {sets} WHERE id=?", [*data.values(), tid])
        if "due_at" in data and data["due_at"] != old["due_at"]:
            self.x("DELETE FROM task_reminders WHERE task_id=?", (tid,))
        return self.get_task(tid)

    def delete_task(self, tid: int) -> bool:
        self.x("DELETE FROM task_reminders WHERE task_id=?", (tid,))
        return self.x("DELETE FROM tasks WHERE id=?", (tid,)) > 0

    def list_tasks(self, status: str | None = None, start: str | None = None, end: str | None = None,
                   overdue: bool = False, limit: int = 500) -> list[dict]:
        where, params = [], []
        if status == "open":
            where.append("status='pending'")
        elif status:
            where.append("status=?")
            params.append(status)
        else:
            where.append("status!='suggested'")
        if start:
            where.append("due_at>=?")
            params.append(start)
        if end:
            where.append("due_at<?")
            params.append(end)
        if overdue:
            where.append("status='pending' AND due_at IS NOT NULL AND due_at<?")
            params.append(now_db())
        sql = "SELECT * FROM tasks"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += (" ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END,"
                " due_at IS NULL, due_at, id DESC LIMIT ?")
        params.append(limit)
        return [self._task_out(r) for r in self.q(sql, params)]  # type: ignore[misc]

    def stats(self) -> dict:
        r = self.q1(
            "SELECT"
            " SUM(status='pending') AS pending,"
            " SUM(status='done') AS done,"
            " SUM(status='suggested') AS suggested,"
            " SUM(status='pending' AND due_at IS NOT NULL AND due_at<?) AS overdue,"
            " COUNT(*) AS total FROM tasks WHERE status!='cancelled'", (now_db(),))
        return {k: int(v or 0) for k, v in (r or {}).items()}

    # ---- eslatmalar ----
    def reminders_sent(self, tid: int) -> set[int]:
        return {r["offset_min"] for r in self.q("SELECT offset_min FROM task_reminders WHERE task_id=?", (tid,))}

    def mark_reminders(self, tid: int, offsets: Iterable[int]) -> None:
        now = now_db()
        for o in offsets:
            self.x("INSERT OR IGNORE INTO task_reminders(task_id,offset_min,sent_at) VALUES(?,?,?)", (tid, o, now))

    def snooze(self, tid: int, minutes: int) -> dict | None:
        return self.update_task(tid, snooze_until=to_db(utcnow() + timedelta(minutes=minutes)))

    # ---- kontaktlar ----
    def upsert_contact(self, tg_id: int, first_name: str | None, last_name: str | None,
                       username: str | None, phone: str | None, is_contact: bool = True) -> None:
        self.x(
            "INSERT INTO contacts(tg_id,first_name,last_name,username,phone,is_contact,updated_at)"
            " VALUES(?,?,?,?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET first_name=excluded.first_name,"
            " last_name=excluded.last_name, username=excluded.username,"
            " phone=COALESCE(excluded.phone, contacts.phone),"
            " is_contact=MAX(contacts.is_contact, excluded.is_contact), updated_at=excluded.updated_at",
            (tg_id, first_name, last_name, username, phone, int(is_contact), now_db()))

    def contacts(self) -> list[dict]:
        return self.q("SELECT * FROM contacts ORDER BY is_contact DESC, first_name")

    # ---- hujjatlar ----
    def add_document(self, file_name: str, mime: str, path: str, summary: str, content: str) -> int:
        return self.x("INSERT INTO documents(file_name,mime,path,summary,content,created_at) VALUES(?,?,?,?,?,?)",
                      (file_name, mime, path, summary, content[:200_000], now_db()))

    def recent_documents(self, limit: int = 10) -> list[dict]:
        return self.q("SELECT id,file_name,summary,created_at FROM documents ORDER BY id DESC LIMIT ?", (limit,))

    # ---- chat xulosalari ----
    def save_chat_summary(self, chat_id: int, title: str, summary: str, last_msg_id: int) -> None:
        self.x("INSERT INTO chat_summaries(chat_id,title,summary,last_msg_id,updated_at) VALUES(?,?,?,?,?)"
               " ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, summary=excluded.summary,"
               " last_msg_id=excluded.last_msg_id, updated_at=excluded.updated_at",
               (chat_id, title, summary, last_msg_id, now_db()))

    def chat_summary(self, chat_id: int) -> dict | None:
        return self.q1("SELECT * FROM chat_summaries WHERE chat_id=?", (chat_id,))

    def scan_pos(self, chat_id: int) -> int:
        r = self.q1("SELECT last_msg_id FROM chat_scan WHERE chat_id=?", (chat_id,))
        return int(r["last_msg_id"]) if r else 0

    def set_scan_pos(self, chat_id: int, msg_id: int) -> None:
        self.x("INSERT INTO chat_scan(chat_id,last_msg_id) VALUES(?,?) ON CONFLICT(chat_id)"
               " DO UPDATE SET last_msg_id=MAX(chat_scan.last_msg_id, excluded.last_msg_id)", (chat_id, msg_id))


def is_overdue(task: dict, now: datetime | None = None) -> bool:
    due = from_db(task.get("due_at"))
    return bool(task.get("status") == "pending" and due and due < (now or utcnow()))
