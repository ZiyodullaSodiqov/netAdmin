"""Telegram userbot (o'z akkauntingiz) — FAQAT O'QISH rejimida.

- Barcha chatlardagi kiruvchi va chiquvchi xabarlarni bazaga yozadi (tahrir va o'chirishlar ham qayd etiladi).
- Kontaktlarni o'qiydi (vazifa kimga tegishli ekanini aniqlash uchun).
- Hech qachon xabar yubormaydi, "o'qildi" belgisini qo'ymaydi, "yozmoqda..." ko'rsatmaydi —
  bu `guard.check_request` orqali MTProto darajasida bloklangan.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from telethon import TelegramClient, events, functions, types, utils

from .guard import check_request
from .timeutil import to_db

if TYPE_CHECKING:
    from .ai.base import AI
    from .config import Config
    from .db import Database
    from .store import MessageStore

log = logging.getLogger(__name__)


class ReadOnlyClient(TelegramClient):
    """Har bir so'rovni yuborishdan oldin tekshiradi: yozish amallari taqiqlangan."""

    async def _call(self, sender, request, ordered=False, flood_sleep_threshold=None):  # type: ignore[override]
        check_request(request)
        return await super()._call(sender, request, ordered=ordered, flood_sleep_threshold=flood_sleep_threshold)


def make_client(cfg: "Config") -> ReadOnlyClient:
    cfg.ensure_dirs()
    return ReadOnlyClient(
        str(cfg.session_path), cfg.api_id, cfg.api_hash,
        catch_up=True,
        device_model="Yordamchi", app_version="1.0", system_version="local",
    )


def chat_kind(entity: Any) -> str:
    if isinstance(entity, types.User):
        return "bot" if entity.bot else "user"
    if isinstance(entity, (types.Chat, types.ChatForbidden)):
        return "group"
    if isinstance(entity, (types.Channel, types.ChannelForbidden)):
        return "supergroup" if getattr(entity, "megagroup", False) else "channel"
    return "unknown"


def entity_title(entity: Any) -> str:
    if isinstance(entity, types.User):
        name = " ".join(x for x in (entity.first_name, entity.last_name) if x).strip()
        return name or (f"@{entity.username}" if entity.username else str(entity.id))
    return getattr(entity, "title", None) or str(getattr(entity, "id", "?"))


def media_type(msg: Any) -> str | None:
    if not msg.media:
        return None
    if msg.voice:
        return "voice"
    if msg.video_note:
        return "video_note"
    if msg.audio:
        return "audio"
    if msg.photo:
        return "photo"
    if msg.video:
        return "video"
    if msg.gif:
        return "gif"
    if msg.sticker:
        return "sticker"
    if msg.contact:
        return "contact"
    if msg.geo or msg.venue:
        return "location"
    if msg.poll:
        return "poll"
    if msg.document:
        return "document"
    if isinstance(msg.media, types.MessageMediaWebPage):
        return None
    return type(msg.media).__name__.replace("MessageMedia", "").lower()


class Userbot:
    def __init__(self, cfg: "Config", db: "Database", store: "MessageStore", ai: "AI | None" = None):
        self.cfg = cfg
        self.db = db
        self.store = store
        self.ai = ai
        self.client = make_client(cfg)
        self.me: Any = None
        self._known_chats: set[int] = set()

    # ---------- ishga tushirish ----------
    async def start(self) -> bool:
        await self.client.connect()
        if not await self.client.is_user_authorized():
            log.error("Userbot avtorizatsiyadan o'tmagan. Avval:  python -m yordamchi login")
            return False
        self.me = await self.client.get_me()
        log.info("Userbot ulandi: %s (id=%s) — faqat o'qish rejimi", entity_title(self.me), self.me.id)
        self.client.add_event_handler(self._on_new, events.NewMessage())
        self.client.add_event_handler(self._on_edit, events.MessageEdited())
        self.client.add_event_handler(self._on_delete, events.MessageDeleted())
        asyncio.create_task(self._initial_sync())
        return True

    async def run_forever(self) -> None:
        await self.client.run_until_disconnected()

    async def stop(self) -> None:
        await self.client.disconnect()

    async def _initial_sync(self) -> None:
        try:
            await self.sync_contacts()
            await self.sync_history(backfill=True)
        except Exception:  # noqa: BLE001
            log.exception("Boshlang'ich sinxronlashda xato")

    # ---------- kontaktlar ----------
    async def sync_contacts(self) -> int:
        res = await self.client(functions.contacts.GetContactsRequest(hash=0))
        n = 0
        for u in getattr(res, "users", []):
            self.db.upsert_contact(u.id, u.first_name, u.last_name, u.username, u.phone, True)
            n += 1
        log.info("Kontaktlar: %d ta", n)
        return n

    # ---------- tarix ----------
    async def sync_history(self, backfill: bool = False) -> int:
        """Barcha dialoglardagi yangi xabarlarni bazaga yozadi (oflayn paytdagi bo'shliqlarni to'ldiradi)."""
        total = 0
        async for d in self.client.iter_dialogs():
            ent = d.entity
            chat_id = d.id
            self._remember_chat(chat_id, ent)
            last = self.store.max_msg_id(chat_id)
            if last == 0 and not backfill:
                continue
            if last == 0:
                limit = self.cfg.history_backfill
                if limit <= 0:
                    continue
                it = self.client.iter_messages(ent, limit=limit)
            else:
                it = self.client.iter_messages(ent, min_id=last, limit=2000)
            async for m in it:
                if isinstance(m, types.MessageService):
                    continue
                await self._save(m, chat_id, ent, download=False)
                total += 1
            await asyncio.sleep(0.3)  # flood limitlardan saqlanish
        log.info("Tarix sinxronlandi: %d ta xabar", total)
        return total

    # ---------- hodisalar ----------
    def _remember_chat(self, chat_id: int, ent: Any) -> None:
        if ent is None:
            return
        self.store.upsert_chat(chat_id, entity_title(ent), chat_kind(ent), getattr(ent, "username", None))
        self._known_chats.add(chat_id)
        if isinstance(ent, types.User) and not ent.bot and not ent.is_self:
            self.db.upsert_contact(ent.id, ent.first_name, ent.last_name, ent.username,
                                   getattr(ent, "phone", None), bool(getattr(ent, "contact", False)))

    async def _on_new(self, event: events.NewMessage.Event) -> None:
        try:
            msg = event.message
            if isinstance(msg, types.MessageService):
                return
            chat = await event.get_chat()
            await self._save(msg, event.chat_id, chat, download=True)
        except Exception:  # noqa: BLE001
            log.exception("Xabarni saqlashda xato")

    async def _on_edit(self, event: events.MessageEdited.Event) -> None:
        try:
            msg = event.message
            exists = self.store.q("SELECT 1 FROM messages WHERE chat_id=? AND msg_id=?", (event.chat_id, msg.id))
            if exists:
                self.store.record_edit(event.chat_id, msg.id, msg.message, to_db(msg.edit_date))
            else:
                await self._save(msg, event.chat_id, await event.get_chat(), download=False)
        except Exception:  # noqa: BLE001
            log.exception("Tahrirni saqlashda xato")

    async def _on_delete(self, event: events.MessageDeleted.Event) -> None:
        try:
            self.store.mark_deleted(event.deleted_ids, event.chat_id)
        except Exception:  # noqa: BLE001
            log.exception("O'chirishni qayd etishda xato")

    async def _save(self, msg: Any, chat_id: int, chat: Any, download: bool) -> None:
        if chat_id not in self._known_chats:
            self._remember_chat(chat_id, chat)
        sender = msg.sender
        if sender is None and msg.sender_id and not msg.out:
            try:
                sender = await msg.get_sender()
            except Exception:  # noqa: BLE001
                sender = None
        mtype = media_type(msg)
        path = None
        if download and mtype and self.cfg.store_media:
            path = await self._download(msg, chat_id)
        fwd = None
        if msg.fwd_from:
            fwd = msg.fwd_from.from_name or (str(utils.get_peer_id(msg.fwd_from.from_id)) if msg.fwd_from.from_id else "?")
        self.store.save_message(
            chat_id=chat_id, msg_id=msg.id,
            is_channel=isinstance(chat, (types.Channel, types.ChannelForbidden)) or isinstance(msg.peer_id, types.PeerChannel),
            sender_id=msg.sender_id, sender_name=entity_title(sender) if sender else None,
            out=bool(msg.out), date=to_db(msg.date), text=msg.message or None,
            media_type=mtype, media_path=path,
            reply_to=msg.reply_to.reply_to_msg_id if msg.reply_to else None,
            fwd_from=fwd, edited_at=to_db(msg.edit_date) if msg.edit_date else None,
        )
        if (download and mtype in ("voice", "video_note") and self.cfg.transcribe_chat_voices and self.ai
                and isinstance(chat, types.User) and not chat.bot):
            asyncio.create_task(self._transcribe(msg, chat_id))

    async def _download(self, msg: Any, chat_id: int) -> str | None:
        try:
            size = getattr(getattr(msg, "file", None), "size", 0) or 0
            if size > self.cfg.store_media_max_mb * 1024 * 1024:
                return None
            folder = Path(self.cfg.media_dir) / str(chat_id)
            folder.mkdir(parents=True, exist_ok=True)
            p = await self.client.download_media(msg, file=str(folder / f"{msg.id}_"))
            return str(p) if p else None
        except Exception as e:  # noqa: BLE001
            log.warning("Media yuklab olinmadi: %s", e)
            return None

    async def _transcribe(self, msg: Any, chat_id: int) -> None:
        try:
            data = await self.client.download_media(msg, file=bytes)
            if data and self.ai:
                text = await self.ai.transcribe(data, getattr(msg.file, "mime_type", None) or "audio/ogg")
                self.store.set_transcript(chat_id, msg.id, text)
        except Exception as e:  # noqa: BLE001
            log.warning("Ovozli xabar transkripsiyasi xatosi: %s", e)


async def interactive_login(cfg: "Config") -> None:
    """Birinchi marta: telefon raqam va SMS/Telegram kodi orqali kirish."""
    client = make_client(cfg)
    await client.start(phone=cfg.phone or (lambda: input("Telefon raqam (+998...): ")))
    me = await client.get_me()
    print(f"\n✅ Kirildi: {entity_title(me)}  (Telegram ID: {me.id})")
    print(f"   .env faylida OWNER_ID={me.id} ekanini tekshiring.")
    print(f"   Sessiya fayli: {cfg.session_path}.session — uni hech kimga bermang!")
    await client.disconnect()
