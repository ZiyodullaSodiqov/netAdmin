"""Telegram Business rejimi: bot akkaunt sozlamalaridan ulanadi (Sozlamalar → Telegram Business → Chatbotlar).

my.telegram.org dan API ID/HASH kerak emas. Bot shaxsiy (1-ga-1) chatlardagi kiruvchi va chiquvchi xabarlarni,
tahrir va o'chirishlarni oladi va bazaga yozadi. Hech qachon javob yozmaydi va "o'qildi" belgisini qo'ymaydi —
`bot.OwnerOnlyMiddleware` business_connection_id li har qanday so'rovni bloklaydi.

Cheklovlar (Telegram tomonidan): Telegram Premium kerak; faqat shaxsiy chatlar (guruh/kanal yo'q);
ulangan paytdan oldingi tarix va kontaktlar ro'yxati berilmaydi.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from aiogram import Bot, Router
from aiogram.types import BusinessConnection, BusinessMessagesDeleted, Message

from .timeutil import to_db

if TYPE_CHECKING:
    from .agent import Reply
    from .ai.base import AI
    from .config import Config
    from .db import Database
    from .store import MessageStore

log = logging.getLogger(__name__)

RISKY_RIGHTS = ("can_reply", "can_delete_sent_messages", "can_delete_all_messages", "can_delete_outgoing_messages",
                "can_edit_name", "can_edit_bio", "can_edit_profile_photo", "can_edit_username", "can_transfer_stars",
                "can_transfer_and_upgrade_gifts", "can_convert_gifts_to_stars", "can_manage_stories")


def message_media_type(m: Message) -> str | None:
    for attr, name in (("voice", "voice"), ("video_note", "video_note"), ("audio", "audio"), ("photo", "photo"),
                       ("video", "video"), ("animation", "gif"), ("sticker", "sticker"), ("contact", "contact"),
                       ("location", "location"), ("venue", "location"), ("poll", "poll"), ("document", "document")):
        if getattr(m, attr, None):
            return name
    return None


def user_name(u: Any) -> str | None:
    if u is None:
        return None
    name = " ".join(x for x in (getattr(u, "first_name", None), getattr(u, "last_name", None)) if x).strip()
    return name or (f"@{u.username}" if getattr(u, "username", None) else str(getattr(u, "id", "")) or None)


def forward_name(m: Message) -> str | None:
    o = m.forward_origin
    if o is None:
        return None
    return (user_name(getattr(o, "sender_user", None)) or getattr(o, "sender_user_name", None)
            or getattr(getattr(o, "sender_chat", None) or getattr(o, "chat", None), "title", None) or "?")


class BusinessReader:
    def __init__(self, cfg: "Config", db: "Database", store: "MessageStore", bot: Bot,
                 notify: Callable[[list["Reply"]], Awaitable[None]], ai: "AI | None" = None):
        self.cfg = cfg
        self.db = db
        self.store = store
        self.bot = bot
        self.notify = notify
        self.ai = ai
        self.router = Router(name="business")
        self.router.business_connection.register(self._on_connection)
        self.router.business_message.register(self._on_message)
        self.router.edited_business_message.register(self._on_edit)
        self.router.deleted_business_messages.register(self._on_deleted)

    # ---------- ulanish ----------
    def _ids(self) -> set[str]:
        return set(self.db.get_json("business_connections", []))

    def _set_ids(self, ids: set[str]) -> None:
        self.db.set_json("business_connections", sorted(ids))

    async def _allowed(self, conn_id: str | None) -> bool:
        if not conn_id:
            return False
        if conn_id in self._ids():
            return True
        try:
            conn = await self.bot.get_business_connection(conn_id)
        except Exception as e:  # noqa: BLE001
            log.warning("Business ulanishini tekshirib bo'lmadi: %s", e)
            return False
        if conn.user.id == self.cfg.owner_id and conn.is_enabled:
            self._set_ids(self._ids() | {conn_id})
            return True
        return False

    async def _on_connection(self, conn: BusinessConnection) -> None:
        from .agent import Reply

        if conn.user.id != self.cfg.owner_id:
            # Boshqa odam botni o'z akkauntiga ulamoqchi — e'tiborsiz qoldiramiz (unga hech narsa yozilmaydi).
            log.warning("Begona business ulanish e'tiborsiz qoldirildi: user_id=%s", conn.user.id)
            return
        ids = self._ids()
        if conn.is_enabled:
            self._set_ids(ids | {conn.id})
            text = ("✅ <b>Akkauntingizga ulandim</b> (Telegram Business).\n"
                    "Shaxsiy chatlardagi xabarlarni o'qib, vazifalarni topaman. Chatlarga hech narsa yozmayman.")
            rights = conn.rights
            risky = [r for r in RISKY_RIGHTS if rights is not None and getattr(rights, r, False)]
            if risky or (rights is None and conn.can_reply):
                text += ("\n\n🔒 Xavfsizlik uchun: Sozlamalar → Telegram Business → Chatbotlar → bot ruxsatlarida "
                         "<b>faqat xabarlarni o'qish</b>ni qoldirib, javob yozish/o'chirish/profilni tahrirlash "
                         "ruxsatlarini o'chirib qo'yishingiz mumkin. Men ulardan baribir foydalanmayman.")
            await self.notify([Reply(text)])
        else:
            self._set_ids(ids - {conn.id})
            await self.notify([Reply("⚠️ Telegram Business ulanishi o'chirildi — chatlarni endi o'qimayman.")])

    # ---------- xabarlar ----------
    async def _on_message(self, m: Message) -> None:
        try:
            if await self._allowed(m.business_connection_id):
                await self.save(m)
        except Exception:  # noqa: BLE001
            log.exception("Business xabarni saqlashda xato")

    async def _on_edit(self, m: Message) -> None:
        try:
            if not await self._allowed(m.business_connection_id):
                return
            exists = self.store.q("SELECT 1 FROM messages WHERE chat_id=? AND msg_id=?", (m.chat.id, m.message_id))
            if exists:
                self.store.record_edit(m.chat.id, m.message_id, m.text or m.caption,
                                       to_db(m.edit_date) if m.edit_date else None)
            else:
                await self.save(m, download=False)
        except Exception:  # noqa: BLE001
            log.exception("Business tahrirni saqlashda xato")

    async def _on_deleted(self, e: BusinessMessagesDeleted) -> None:
        try:
            if await self._allowed(e.business_connection_id):
                self.store.mark_deleted(e.message_ids, e.chat.id)
        except Exception:  # noqa: BLE001
            log.exception("Business o'chirishni qayd etishda xato")

    async def save(self, m: Message, download: bool = True) -> None:
        chat = m.chat
        kind = "user"
        self.store.upsert_chat(chat.id, user_name(chat) or chat.title, kind, chat.username)
        if chat.id != self.cfg.owner_id:
            self.db.upsert_contact(chat.id, chat.first_name, chat.last_name, chat.username, None, False)
        out = bool(m.from_user and m.from_user.id == self.cfg.owner_id)
        mtype = message_media_type(m)
        path = None
        if download and mtype and self.cfg.store_media:
            path = await self._download(m, chat.id)
        self.store.save_message(
            chat_id=chat.id, msg_id=m.message_id, is_channel=False,
            sender_id=m.from_user.id if m.from_user else None, sender_name=user_name(m.from_user),
            out=out, date=to_db(m.date), text=m.text or m.caption or None,
            media_type=mtype, media_path=path,
            reply_to=m.reply_to_message.message_id if m.reply_to_message else None,
            fwd_from=forward_name(m), edited_at=to_db(m.edit_date) if m.edit_date else None,
        )
        if download and mtype in ("voice", "video_note") and self.cfg.transcribe_chat_voices and self.ai:
            asyncio.create_task(self._transcribe(m))

    def _file(self, m: Message) -> Any:
        if m.photo:
            return m.photo[-1]
        for attr in ("voice", "video_note", "audio", "video", "animation", "document", "sticker"):
            f = getattr(m, attr, None)
            if f:
                return f
        return None

    async def _download(self, m: Message, chat_id: int) -> str | None:
        f = self._file(m)
        if f is None:
            return None
        size = getattr(f, "file_size", 0) or 0
        if size > min(self.cfg.store_media_max_mb, 20) * 1024 * 1024:  # Bot API 20 MB gacha yuklab oladi
            return None
        try:
            folder = Path(self.cfg.media_dir) / str(chat_id)
            folder.mkdir(parents=True, exist_ok=True)
            name = getattr(f, "file_name", None) or f.file_unique_id
            dest = folder / f"{m.message_id}_{name}"
            await self.bot.download(f.file_id, destination=dest)
            return str(dest)
        except Exception as e:  # noqa: BLE001
            log.warning("Media yuklab olinmadi: %s", e)
            return None

    async def _transcribe(self, m: Message) -> None:
        import io

        try:
            f = self._file(m)
            buf = io.BytesIO()
            await self.bot.download(f.file_id, destination=buf)
            text = await self.ai.transcribe(buf.getvalue(), getattr(f, "mime_type", None) or "audio/ogg")  # type: ignore[union-attr]
            self.store.set_transcript(m.chat.id, m.message_id, text)
        except Exception as e:  # noqa: BLE001
            log.warning("Ovozli xabar transkripsiyasi xatosi: %s", e)
