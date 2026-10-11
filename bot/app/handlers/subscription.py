"""Kanalga majburiy obuna."""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware, Bot, F, Router
from aiogram.enums import ChatMemberStatus
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, TelegramObject

from ..channels import get_channels
from ..config import config

log = logging.getLogger(__name__)
router = Router()

OK_STATUSES = {ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR,
               ChatMemberStatus.RESTRICTED}


async def missing_channels(bot: Bot, user_id: int) -> list[str]:
    missing = []
    for ch in await get_channels():
        try:
            m = await bot.get_chat_member(ch, user_id)
            if m.status not in OK_STATUSES or (m.status == ChatMemberStatus.RESTRICTED
                                               and not getattr(m, "is_member", True)):
                missing.append(ch)
        except Exception:  # noqa: BLE001 — bot kanalda admin bo'lmasa
            log.exception("get_chat_member failed for %s (bot kanalda adminmi?)", ch)
    return missing


async def sub_keyboard(bot: Bot, channels: list[str]) -> InlineKeyboardMarkup:
    rows = []
    for ch in channels:
        url = f"https://t.me/{ch.lstrip('@')}" if ch.startswith("@") else None
        if not url:
            try:
                chat = await bot.get_chat(ch)
                url = chat.invite_link or (f"https://t.me/{chat.username}" if chat.username else None)
            except Exception:  # noqa: BLE001
                url = None
        if url:
            rows.append([InlineKeyboardButton(text="➕ Obuna bo'lish", url=url)])
    rows.append([InlineKeyboardButton(text="✅ Tekshirish", callback_data="check_sub")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


class SubscriptionMiddleware(BaseMiddleware):
    async def __call__(self, handler: Callable[[TelegramObject, dict], Awaitable[Any]], event: TelegramObject,
                       data: dict) -> Any:
        user = data.get("event_from_user")
        bot: Bot = data["bot"]
        if not user or user.id in config.admin_ids or not await get_channels():
            return await handler(event, data)
        if isinstance(event, CallbackQuery) and event.data == "check_sub":
            return await handler(event, data)
        missing = await missing_channels(bot, user.id)
        if not missing:
            return await handler(event, data)
        text = "Botdan foydalanish uchun quyidagi kanal(lar)ga obuna bo'ling, so'ng «✅ Tekshirish» ni bosing."
        kb = await sub_keyboard(bot, missing)
        if isinstance(event, Message):
            await event.answer(text, reply_markup=kb)
        elif isinstance(event, CallbackQuery):
            await event.answer("Avval kanalga obuna bo'ling", show_alert=True)
            await event.message.answer(text, reply_markup=kb)
        return None


@router.callback_query(F.data == "check_sub")
async def check_sub(cb: CallbackQuery, bot: Bot):
    missing = await missing_channels(bot, cb.from_user.id)
    if missing:
        await cb.answer("Hali obuna bo'lmadingiz ❗️", show_alert=True)
        return
    from ..ui import main_menu
    await cb.message.edit_text("✅ Rahmat! Xizmatni tanlang:", reply_markup=main_menu())
