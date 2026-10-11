"""Userbot: sizning Telegram akkauntingiz orqali karta xabarlari botining xabarlarini o'qiydi.

Oddiy bot boshqa botning xabarlarini o'qiy olmaydi (Telegram cheklovi), shuning uchun
Telethon orqali egasining akkauntidan foydalaniladi. Faqat NOTIFY_BOT_USERNAME dan kelgan xabarlar o'qiladi.
"""
from __future__ import annotations

import logging

from ..config import config
from ..db import DB
from .parser import parse_card_message

log = logging.getLogger(__name__)


async def store_message(db: DB, text: str, msg_date, msg_id: int) -> int | None:
    tx = parse_card_message(text, config.tz)
    if not tx:
        return None
    paid_at = tx.paid_at or msg_date
    pid = await db.add_card_payment(tx.amount, paid_at, tx.card_last4, text, msg_id)
    if pid:
        log.info("Card credit saved: %s so'm at %s (id=%s)", tx.amount, paid_at, pid)
    return pid


async def start_userbot(db: DB):
    if not (config.tg_api_id and config.tg_api_hash and config.tg_session_string and config.notify_bot_username):
        log.warning("Userbot sozlanmagan — to'lovlar admin tomonidan qo'lda tasdiqlanadi")
        return None
    from telethon import TelegramClient, events
    from telethon.sessions import StringSession

    client = TelegramClient(StringSession(config.tg_session_string), config.tg_api_id, config.tg_api_hash)
    await client.start()
    source = await client.get_entity(config.notify_bot_username)

    @client.on(events.NewMessage(from_users=source))
    async def _on_msg(event):  # noqa: ANN001
        await store_message(db, event.raw_text or "", event.message.date, event.message.id)

    # Bot ishga tushguncha kelgan xabarlarni ham olamiz
    async for m in client.iter_messages(source, limit=50):
        await store_message(db, m.raw_text or "", m.date, m.id)
    log.info("Userbot ishga tushdi, @%s kuzatilmoqda", config.notify_bot_username)
    return client
