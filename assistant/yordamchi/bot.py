"""Telegram bot — faqat egasi bilan muloqot qiladi (OWNER_ID)."""
from __future__ import annotations

import io
import logging
from typing import Any, Awaitable

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.middlewares.base import BaseRequestMiddleware
from aiogram.filters import Command, CommandStart
from aiogram.types import (BotCommand, BotCommandScopeChat, CallbackQuery, InlineKeyboardButton,
                           InlineKeyboardMarkup, Message)

from .agent import Agent, Reply, esc
from .ai.base import AIError
from .config import Config
from . import weather

log = logging.getLogger(__name__)

HELP = """🤖 <b>Shaxsiy yordamchingiz</b>

Menga oddiy matn yoki <b>ovozli xabar</b> yuboring — vazifalarni o'zim ajratib, tushunarli qilib yozib qo'yaman.
Vaqti aytilmagan bo'lsa, qachon ekanini so'rayman va vaqti yaqinlashganda eslataman.

Misollar:
• <i>Ertaga soat 10 da Akmal bilan uchrashuv, shartnomani olib borish kerak</i>
• <i>Juma kuni ijara pulini to'lash</i>
• <i>Bugun nima ishlarim bor?</i>
• <i>#5 bajarildi</i>
• <i>Sardor bilan chatda nima haqida gaplashgandik?</i>

Hujjat, PDF yoki rasm yuborsangiz — o'qib, xulosa qilaman va undagi vazifalarni ajrataman.
Kontakt yuborsangiz — oxirgi vazifani o'sha odamga biriktiraman.

<b>Buyruqlar</b>
/today — bugungi vazifalar
/tomorrow — ertangi
/week — 7 kunlik
/open — barcha bajarilmaganlar
/done — bajarilganlar
/overdue — muddati o'tganlar
/suggested — chatlardan topilgan takliflar
/chats — chatlar va ularning xulosasi
/weather — ob-havo
/brief — kunlik xabar (har kuni ertalab avtomatik)
/web — web sahifa manzili"""


class OwnerOnlyMiddleware(BaseRequestMiddleware):
    """Bot faqat egasining shaxsiy chatiga yoza oladi — boshqa hech qayerga emas."""

    def __init__(self, owner_id: int):
        self.owner_id = owner_id

    async def __call__(self, make_request, bot, method):  # type: ignore[override]
        if getattr(method, "business_connection_id", None):
            # Telegram Business: egasining nomidan hech qanday amal (javob, "o'qildi", o'chirish) bajarilmaydi.
            log.error("Bloklandi: business ulanish orqali %s", type(method).__name__)
            raise PermissionError("Business ulanish orqali yozish taqiqlangan")
        chat_id = getattr(method, "chat_id", None)
        if chat_id is not None and str(chat_id) != str(self.owner_id):
            log.error("Bloklandi: bot %s ga %s yubormoqchi edi", chat_id, type(method).__name__)
            raise PermissionError("Bot faqat egasiga yozishi mumkin")
        return await make_request(bot, method)


def keyboard(buttons: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup | None:
    if not buttons:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=label, callback_data=data) for label, data in row] for row in buttons])


def split_text(text: str, limit: int = 4000) -> list[str]:
    if len(text) <= limit:
        return [text]
    chunks, cur = [], ""
    for line in text.split("\n"):
        while len(line) > limit:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(line[:limit])
            line = line[limit:]
        if len(cur) + len(line) + 1 > limit:
            chunks.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        chunks.append(cur)
    return chunks


class AssistantBot:
    def __init__(self, cfg: Config, agent: Agent, ai: Any = None):
        self.cfg = cfg
        self.agent = agent
        self.bot = Bot(cfg.bot_token, default=DefaultBotProperties(parse_mode="HTML",
                                                                   link_preview_is_disabled=True))
        self.bot.session.middleware(OwnerOnlyMiddleware(cfg.owner_id))
        self.dp = Dispatcher()
        self.router = Router()
        owner = F.from_user.id == cfg.owner_id
        self.router.message.filter(owner, F.chat.type == "private")
        self.router.callback_query.filter(owner)
        self._register()
        self.dp.include_router(self.router)
        self.business = None
        if cfg.business_enabled and agent.store is not None:
            from .business import BusinessReader
            self.business = BusinessReader(cfg, agent.db, agent.store, self.bot, self.send, ai)
            self.dp.include_router(self.business.router)

    # ---------- yuborish ----------
    async def send(self, replies: list[Reply] | Reply) -> None:
        if isinstance(replies, Reply):
            replies = [replies]
        for r in replies:
            parts = split_text(r.text)
            for i, part in enumerate(parts):
                kb = keyboard(r.buttons) if i == len(parts) - 1 else None
                try:
                    await self.bot.send_message(self.cfg.owner_id, part, reply_markup=kb)
                except Exception as e:  # noqa: BLE001
                    log.warning("HTML bilan yuborilmadi (%s), oddiy matn sifatida yuboriladi", e)
                    await self.bot.send_message(self.cfg.owner_id, part, reply_markup=kb, parse_mode=None)

    async def _typing(self) -> None:
        try:
            await self.bot.send_chat_action(self.cfg.owner_id, "typing")
        except Exception:  # noqa: BLE001
            pass

    async def _safe(self, coro: Awaitable[list[Reply] | Reply]) -> None:
        await self._typing()
        try:
            res = await coro
        except AIError as e:
            log.warning("AI xatosi: %s", e)
            res = Reply(f"⚠️ AI xizmati javob bermadi. Keyinroq urinib ko'ring.\n<code>{esc(str(e)[:300])}</code>")
        except Exception as e:  # noqa: BLE001
            log.exception("Xato")
            res = Reply(f"⚠️ Xatolik: <code>{esc(str(e)[:300])}</code>")
        await self.send(res)

    async def _download(self, file_id: str) -> bytes:
        buf = io.BytesIO()
        await self.bot.download(file_id, destination=buf)
        return buf.getvalue()

    # ---------- handlerlar ----------
    def _register(self) -> None:
        r = self.router
        a = self.agent

        @r.message(CommandStart())
        @r.message(Command("help"))
        async def _help(m: Message) -> None:
            await m.answer(HELP)

        for cmd, flt in (("today", "today"), ("tasks", "today"), ("tomorrow", "tomorrow"), ("week", "week"),
                         ("open", "open"), ("done", "done"), ("overdue", "overdue"), ("all", "all")):
            def make(f: str):
                async def _h(m: Message) -> None:
                    await self.send(a.list_tasks(f))
                return _h
            r.message.register(make(flt), Command(cmd))

        @r.message(Command("suggested"))
        async def _sugg(m: Message) -> None:
            from .agent import task_buttons, task_card
            items = a.db.list_tasks("suggested")
            if not items:
                await m.answer("Ko'rib chiqilmagan taklif yo'q.")
                return
            await self.send([Reply(task_card(t, a.tz, "💡"), task_buttons(t)) for t in items[:15]])

        @r.message(Command("chats"))
        async def _chats(m: Message) -> None:
            await self.send(a.list_chats())

        @r.message(Command("weather"))
        async def _weather(m: Message) -> None:
            try:
                w = await weather.fetch(self.cfg.weather_lat, self.cfg.weather_lon, self.cfg.timezone)
                await m.answer(weather.format_brief(self.cfg.weather_city, w))
            except Exception as e:  # noqa: BLE001
                await m.answer(f"Ob-havo olinmadi: {esc(e)}")

        @r.message(Command("brief"))
        async def _brief(m: Message) -> None:
            await self._safe(a.daily_brief())

        @r.message(Command("web"))
        async def _web(m: Message) -> None:
            host = "localhost" if self.cfg.web_host in ("0.0.0.0", "127.0.0.1") else self.cfg.web_host
            await m.answer(f"🌐 Web sahifa (kompyuteringizda): http://{host}:{self.cfg.web_port}")

        @r.message(F.voice | F.audio | F.video_note)
        async def _voice(m: Message) -> None:
            obj: Any = m.voice or m.audio or m.video_note
            mime = getattr(obj, "mime_type", None) or ("video/mp4" if m.video_note else "audio/ogg")

            async def run() -> list[Reply]:
                data = await self._download(obj.file_id)
                return await a.handle_voice(data, mime)
            await self._safe(run())

        @r.message(F.document)
        async def _doc(m: Message) -> None:
            d = m.document

            async def run() -> list[Reply]:
                if d.file_size and d.file_size > 20 * 1024 * 1024:
                    return [Reply("Fayl juda katta (Telegram bot 20 MB gacha yuklab oladi).")]
                data = await self._download(d.file_id)
                if (d.mime_type or "").startswith("audio/"):
                    return await a.handle_voice(data, d.mime_type)
                return await a.handle_document(data, d.file_name or "file", d.mime_type, m.caption or "")
            await self._safe(run())

        @r.message(F.photo)
        async def _photo(m: Message) -> None:
            p = m.photo[-1]

            async def run() -> list[Reply]:
                data = await self._download(p.file_id)
                return await a.handle_document(data, "photo.jpg", "image/jpeg", m.caption or "")
            await self._safe(run())

        @r.message(F.contact)
        async def _contact(m: Message) -> None:
            c = m.contact
            await self.send(a.assign_contact(c.user_id, c.first_name, c.last_name, c.phone_number))

        @r.message(F.text)
        async def _text(m: Message) -> None:
            reply_text = m.reply_to_message.text if m.reply_to_message and m.reply_to_message.text else None
            await self._safe(a.handle_text(m.text, "text", reply_text))

        @r.callback_query()
        async def _cb(q: CallbackQuery) -> None:
            await q.answer()
            data = q.data or ""
            parts = data.split(":")
            try:
                kind, tid = parts[0], int(parts[1])
            except (IndexError, ValueError):
                return
            edit: Reply | None = None
            send: list[Reply] = []
            if kind == "done":
                edit = a.complete(tid)
            elif kind == "undo":
                edit = a.reopen(tid)
            elif kind == "del":
                edit = a.delete(tid)
            elif kind == "acc":
                send = a.accept(tid)
                edit = Reply(send.pop(0).text) if send else None
            elif kind == "rej":
                edit = a.reject(tid)
            elif kind == "snz" and len(parts) > 2:
                edit = a.snooze(tid, int(parts[2]))
            elif kind == "due" and len(parts) > 2:
                send = a.quick_due(tid, parts[2])
            elif kind == "chat":
                await self._safe(a.summarize_chat(tid))
                return
            if edit and q.message:
                try:
                    await q.message.edit_text(edit.text, reply_markup=keyboard(edit.buttons))
                except Exception:  # noqa: BLE001
                    send.insert(0, edit)
            elif edit:
                send.insert(0, edit)
            if kind == "due" and q.message:
                try:
                    await q.message.edit_reply_markup(reply_markup=None)
                except Exception:  # noqa: BLE001
                    pass
            if send:
                await self.send(send)

    async def setup_commands(self) -> None:
        cmds = [("today", "Bugungi vazifalar"), ("tomorrow", "Ertangi vazifalar"), ("week", "7 kunlik reja"),
                ("open", "Bajarilmaganlar"), ("done", "Bajarilganlar"), ("overdue", "Muddati o'tganlar"),
                ("suggested", "Chatlardan takliflar"), ("chats", "Chatlar xulosasi"), ("weather", "Ob-havo"),
                ("brief", "Kunlik xabar"), ("web", "Web sahifa"), ("help", "Yordam")]
        try:
            await self.bot.set_my_commands([BotCommand(command=c, description=d) for c, d in cmds],
                                           scope=BotCommandScopeChat(chat_id=self.cfg.owner_id))
        except Exception as e:  # noqa: BLE001
            log.warning("Buyruqlar ro'yxatini o'rnatib bo'lmadi: %s", e)

    async def run(self) -> None:
        await self.setup_commands()
        me = await self.bot.get_me()
        log.info("Bot ishga tushdi: @%s (faqat egasi: %s)", me.username, self.cfg.owner_id)
        updates = ["message", "callback_query"]
        if self.business:
            updates += ["business_connection", "business_message", "edited_business_message",
                        "deleted_business_messages"]
        await self.dp.start_polling(self.bot, handle_signals=False, allowed_updates=updates)
