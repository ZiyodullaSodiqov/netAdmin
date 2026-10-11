"""Rasmdagi misolni yechish: 1-si bepul, keyin 10 ta misol — 3 000 so'm."""
from __future__ import annotations

import io
import logging

from aiogram import Bot, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message
from aiogram.utils.chat_action import ChatActionSender

from ..db import db
from ..generators.math_solve import format_html, solve
from ..services import SERVICES, fmt_sum
from .. import ui
from .order import Flow, to_payment

log = logging.getLogger(__name__)
router = Router()
SVC = SERVICES["math"]


def _buy_kb():
    return ui.ikb([[(f"💳 {SVC.extra['pack']} ta misol — {fmt_sum(SVC.price)}", "math_buy")], [("⬅️ Menyu", "menu")]])


async def enter_math(msg: Message, uid: int, state: FSMContext) -> None:
    u = await db.get_user(uid)
    left = (0 if u["free_math_used"] else 1) + u["math_credits"]
    await state.set_state(Flow.math)
    if left <= 0:
        await msg.answer("Bepul misol ishlatilgan. Davom etish uchun paket xarid qiling:", reply_markup=_buy_kb())
        return
    free = "" if u["free_math_used"] else " (1-si bepul!)"
    await msg.answer(f"🧮 Misol rasmini yuboring{free}. Qolgan: {left} ta.", reply_markup=ui.ikb([[("⬅️ Menyu", "menu")]]))


@router.message(Flow.math, F.photo | F.document)
async def math_photo(msg: Message, state: FSMContext, bot: Bot):
    if msg.document and not (msg.document.mime_type or "").startswith("image/"):
        await msg.answer("Rasm yuboring.")
        return
    how = await db.use_math(msg.from_user.id)
    if not how:
        await msg.answer("Misollar soni tugadi. Paket xarid qiling:", reply_markup=_buy_kb())
        return
    buf = io.BytesIO()
    obj = msg.photo[-1] if msg.photo else msg.document
    await bot.download(obj, destination=buf)
    wait = await msg.answer("⏳ Yechilmoqda...")
    try:
        async with ChatActionSender.typing(bot=bot, chat_id=msg.chat.id):
            d = await solve(buf.getvalue(), "image/jpeg" if msg.photo else msg.document.mime_type)
    except Exception:  # noqa: BLE001
        log.exception("math solve failed")
        d = None
    if not d or not d.get("readable", True) or not d.get("problems"):
        await db.refund_math(msg.from_user.id, how)
        await wait.edit_text("Rasmdagi misolni o'qib bo'lmadi (huquq qaytarildi). Aniqroq rasm yuboring.")
        return
    text = format_html(d)
    await wait.delete()
    for i in range(0, len(text), 4000):
        await msg.answer(text[i:i + 4000])
    u = await db.get_user(msg.from_user.id)
    left = (0 if u["free_math_used"] else 1) + u["math_credits"]
    if left:
        await msg.answer(f"Yana misol yuborishingiz mumkin. Qolgan: {left} ta.")
    else:
        await msg.answer("Misollar tugadi. Davom etish uchun:", reply_markup=_buy_kb())


@router.callback_query(F.data == "math_buy")
async def math_buy(cb: CallbackQuery, state: FSMContext):
    await cb.answer()
    oid = await db.create_order(cb.from_user.id, "math", {"pack": SVC.extra["pack"]}, SVC.price, 0)
    await to_payment(cb.message, state, await db.get_order(oid))
