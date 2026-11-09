"""Fon vazifalari: eslatmalar, ertalabki xabar, tarixni sinxronlash, chatlardan vazifa topish."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, time, timedelta
from typing import TYPE_CHECKING, Awaitable, Callable

from .timeutil import parse_hhmm, to_db, utcnow

if TYPE_CHECKING:
    from .agent import Agent, Reply
    from .userbot import Userbot

log = logging.getLogger(__name__)

Notify = Callable[[list["Reply"]], Awaitable[None]]


def due_today(now_local: datetime, at: time, last_done: str | None) -> bool:
    """Bugun `at` vaqti o'tgan va hali bajarilmagan bo'lsa True."""
    return now_local.time() >= at and last_done != now_local.date().isoformat()


class Scheduler:
    def __init__(self, agent: "Agent", notify: Notify, userbot: "Userbot | None" = None, tick: int = 30):
        self.agent = agent
        self.cfg = agent.cfg
        self.db = agent.db
        self.notify = notify
        self.userbot = userbot
        self.tick = tick
        self._last_scan = datetime.min

    async def run(self) -> None:
        log.info("Rejalashtiruvchi ishga tushdi (ertalabki xabar %s, eslatmalar: %s daq oldin)",
                 self.cfg.daily_brief_time, self.cfg.reminder_offsets)
        while True:
            await self.step()
            await asyncio.sleep(self.tick)

    async def step(self) -> None:
        for fn in (self.reminders, self.morning_brief, self.daily_sync, self.chat_scan):
            try:
                await fn()
            except Exception:  # noqa: BLE001
                log.exception("Fon vazifasida xato: %s", fn.__name__)

    async def reminders(self) -> None:
        replies = self.agent.collect_reminders()
        if replies:
            await self.notify(replies)

    async def morning_brief(self) -> None:
        now = datetime.now(self.cfg.tz)
        at = parse_hhmm(self.cfg.daily_brief_time, time(8, 0))
        if not due_today(now, at, self.db.get("last_brief")):
            return
        # Kompyuter kech yoqilgan bo'lsa ham, soat 13:00 gacha ertalabki xabar yuboriladi.
        self.db.set("last_brief", now.date().isoformat())
        if at < time(13, 0) <= now.time():
            return
        await self.notify([await self.agent.daily_brief()])

    async def daily_sync(self) -> None:
        if not self.userbot or not self.userbot.me:
            return
        now = datetime.now(self.cfg.tz)
        at = parse_hhmm(self.cfg.daily_sync_time, time(8, 0))
        if not due_today(now, at, self.db.get("last_sync")):
            return
        self.db.set("last_sync", now.date().isoformat())
        await self.userbot.sync_contacts()
        await self.userbot.sync_history(backfill=False)

    async def chat_scan(self) -> None:
        if not (self.cfg.chat_task_detection and self.agent.store):
            return
        if datetime.now() - self._last_scan < timedelta(minutes=self.cfg.chat_scan_interval_min):
            return
        self._last_scan = datetime.now()
        kinds = ["user"] + (["group", "supergroup"] if self.cfg.chat_scan_groups else [])
        positions = {r["chat_id"]: r["last_msg_id"] for r in self.db.q("SELECT * FROM chat_scan")}
        since = to_db(utcnow() - timedelta(hours=24))
        chats = self.agent.store.chats_with_new_incoming(kinds, positions, since)  # type: ignore[arg-type]
        for chat_id in chats[:10]:
            if chat_id == self.cfg.owner_id:
                continue
            replies = await self.agent.detect_chat_tasks(chat_id, since)  # type: ignore[arg-type]
            if replies:
                await self.notify(replies)
