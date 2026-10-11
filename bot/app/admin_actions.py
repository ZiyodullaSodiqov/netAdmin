"""Admin amallari — Telegram'dagi tugmalar va web panel ikkalasi shu funksiyalardan foydalanadi."""
from __future__ import annotations

import asyncio
import html
import logging

from aiogram import Bot
from aiogram.exceptions import TelegramRetryAfter

from .db import db
from .delivery import deliver, order_total

log = logging.getLogger(__name__)

KIND_TITLE = {"suggestion": "💡 Taklif", "contact": "📞 Murojaat"}


async def approve_order(bot: Bot, oid: int) -> tuple[bool, str]:
    order = await db.get_order(oid)
    if not order or order["status"] != "awaiting_payment":
        return False, "Buyurtma allaqachon ko'rib chiqilgan yoki topilmadi."
    pr = order["params"].get("pending_receipt") or {}
    ok = await db.confirm_payment(oid, None, pr.get("id"), pr.get("amount") or order_total(order), None)
    if not ok:
        return False, "Bu chek ID boshqa buyurtmada ishlatilgan!"
    await db.log_event(order["user_id"], "paid", order["service"])
    await deliver(bot, oid)
    return True, f"#{oid} tasdiqlandi va mijozga yuborildi."


async def reject_order(bot: Bot, oid: int) -> tuple[bool, str]:
    order = await db.get_order(oid)
    if not order or order["status"] != "awaiting_payment":
        return False, "Buyurtma allaqachon ko'rib chiqilgan yoki topilmadi."
    await db.update_order(oid, status="rejected")
    try:
        await bot.send_message(order["user_id"], f"❌ Buyurtma #{oid} bo'yicha to'lov tasdiqlanmadi. "
                                                 "To'g'ri chekni yuboring yoki admin bilan bog'laning.")
    except Exception:  # noqa: BLE001
        log.exception("reject notify failed")
    return True, f"#{oid} rad etildi."


async def reply_message(bot: Bot, mid: int, text: str) -> tuple[bool, str]:
    m = await db.get_message(mid)
    if not m:
        return False, "Xabar topilmadi."
    try:
        await bot.send_message(m["user_id"], f"📩 <b>Admin javobi</b> ({KIND_TITLE.get(m['kind'], '')} #{mid}):\n\n"
                                             f"{html.escape(text)}")
    except Exception:  # noqa: BLE001
        return False, "Foydalanuvchiga yetib bormadi (botni bloklagan bo'lishi mumkin)."
    await db.set_message_status(mid, "answered", text)
    return True, "Javob yuborildi."


async def broadcast(bot: Bot, send, user_ids: list[int], progress=None) -> tuple[int, int]:
    """send(uid) — bitta foydalanuvchiga yuboradigan korutina. Qaytaradi: (yetib bordi, yetmadi)."""
    ok = fail = 0
    for i, uid in enumerate(user_ids, 1):
        for attempt in range(2):
            try:
                await send(uid)
                ok += 1
                break
            except TelegramRetryAfter as e:
                await asyncio.sleep(e.retry_after)
            except Exception:  # noqa: BLE001 — botni bloklagan va h.k.
                fail += 1
                break
        else:
            fail += 1
        await asyncio.sleep(0.05)  # ~20 xabar/soniya
        if progress and i % 100 == 0:
            await progress(i, len(user_ids))
    return ok, fail
