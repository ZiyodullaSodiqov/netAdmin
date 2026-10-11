"""Takliflar va adminga murojaat. Admin javobi web paneldan yoki Telegram'da xabarga «reply» qilib yuboriladi."""
from __future__ import annotations

import html
import re

from aiogram import Bot, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from ..admin_actions import KIND_TITLE, reply_message
from ..config import config
from ..db import db
from ..delivery import notify_admins
from .. import ui

router = Router()
MSG_TAG = re.compile(r"#M(\d+)\b")


class Feedback(StatesGroup):
    text = State()


PROMPTS = {
    "suggestion": "💡 Taklif yoki fikringizni yozing — bot va xizmatlarni yaxshilashga yordam beradi.\n"
                  "(Matn, rasm yoki ovozli xabar yuborishingiz mumkin)",
    "contact": "📞 Adminga xabaringizni yozing — savol, muammo yoki buyurtma bo'yicha. Javob shu bot orqali keladi.",
}


@router.callback_query(F.data.startswith("feedback:"))
async def start_feedback(cb: CallbackQuery, state: FSMContext):
    kind = cb.data.split(":", 1)[1]
    if kind not in PROMPTS:
        return
    await cb.answer()
    await state.set_state(Feedback.text)
    await state.update_data(kind=kind)
    text = PROMPTS[kind]
    if kind == "contact" and config.admin_contact:
        text += f"\n\nYoki to'g'ridan-to'g'ri yozing: {html.escape(config.admin_contact)}"
    await cb.message.answer(text, reply_markup=ui.ikb([[("❌ Bekor qilish", "menu")]]))


@router.message(Feedback.text)
async def got_feedback(msg: Message, state: FSMContext, bot: Bot):
    kind = (await state.get_data()).get("kind", "contact")
    text = (msg.text or msg.caption or "").strip()
    if msg.text and text.startswith("/"):
        return
    if not text and not (msg.photo or msg.voice or msg.document or msg.video):
        await msg.answer("Iltimos, xabar matnini yozing.")
        return
    if len(text) > 3000:
        await msg.answer("Xabar juda uzun (3000 belgigacha).")
        return
    await state.clear()
    await db.upsert_user(msg.from_user.id, msg.from_user.username, msg.from_user.full_name)
    stored = text or f"[{'rasm' if msg.photo else 'ovozli xabar' if msg.voice else 'fayl'}]"
    mid = await db.add_message(msg.from_user.id, kind, stored)
    await db.log_event(msg.from_user.id, kind)

    u = msg.from_user
    who = html.escape(u.full_name) + (f" @{u.username}" if u.username else "")
    await notify_admins(bot, f"{KIND_TITLE[kind]} <b>#M{mid}</b>\nKimdan: <a href='tg://user?id={u.id}'>{who}</a>\n\n"
                             f"{html.escape(stored)}\n\n<i>Javob berish uchun shu xabarga «Reply» qiling "
                             f"yoki web panelni oching.</i>")
    if not msg.text:  # rasm/ovoz/fayl — asl xabarni ham adminlarga yuboramiz
        for aid in config.admin_ids:
            try:
                await msg.forward(aid)
            except Exception:  # noqa: BLE001
                pass
    thanks = "✅ Taklifingiz uchun rahmat!" if kind == "suggestion" else \
        "✅ Xabaringiz adminga yuborildi. Javob shu yerga keladi."
    await msg.answer(thanks, reply_markup=ui.main_menu())


# Admin Telegram'da bildirishnomaga «Reply» qilsa — javob foydalanuvchiga boradi
@router.message(F.reply_to_message & F.from_user.id.in_(set(config.admin_ids)) & F.text)
async def admin_reply(msg: Message, bot: Bot):
    src = msg.reply_to_message.text or msg.reply_to_message.caption or ""
    m = MSG_TAG.search(src)
    if not m or not msg.reply_to_message.from_user or not msg.reply_to_message.from_user.is_bot:
        return
    ok, text = await reply_message(bot, int(m.group(1)), msg.text)
    await msg.answer(("✅ " if ok else "❌ ") + text)
