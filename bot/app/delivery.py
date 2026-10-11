"""To'langan buyurtmani yetkazish: fayllarni yuborish, chop etish uchun adminga xabar."""
from __future__ import annotations

import html
import logging
from pathlib import Path

from aiogram import Bot
from aiogram.types import FSInputFile

from .config import config
from .db import db
from .services import SERVICES, fmt_sum
from . import ui

log = logging.getLogger(__name__)


def order_total(o: dict) -> int:
    return o["price"] + (o["print_price"] if o["with_print"] else 0)


async def notify_admins(bot: Bot, text: str, **kw) -> None:
    for aid in config.admin_ids:
        try:
            await bot.send_message(aid, text, **kw)
        except Exception:  # noqa: BLE001
            log.exception("admin %s ga yuborilmadi", aid)


async def deliver(bot: Bot, order_id: int) -> None:
    o = await db.get_order(order_id)
    svc = SERVICES[o["service"]]
    uid = o["user_id"]

    if svc.kind == "math":
        pack = svc.extra["pack"]
        await db.add_math_credits(uid, pack)
        await bot.send_message(uid, f"✅ To'lov qabul qilindi! Sizga {pack} ta misol yechish huquqi qo'shildi.\n"
                                    "Misol rasmini yuboring.", reply_markup=ui.ikb([[("🧮 Misol yuborish", "svc:math")]]))
        await db.update_order(order_id, status="delivered")
        return

    files = [Path(f) for f in o["params"].get("files_out", [])]
    await bot.send_message(uid, f"✅ To'lov tasdiqlandi! Buyurtma #{order_id} — asl fayl(lar):")
    for f in files:
        if f.exists():
            await bot.send_document(uid, FSInputFile(f, filename=f.name))
    if o["with_print"]:
        await bot.send_message(uid, "🖨 Qog'ozda chiqarish buyurtmasi qabul qilindi. Tayyor bo'lgach siz bilan "
                                    "bog'lanamiz.")
        phone = html.escape(o["params"].get("phone", "—"))
        await notify_admins(bot, f"🖨 <b>Chop etish</b> — buyurtma #{order_id}\n{svc.title}\n"
                                 f"Mijoz: <a href='tg://user?id={uid}'>{uid}</a>, tel: {phone}\n"
                                 f"To'langan: {fmt_sum(order_total(o))}")
        for aid in config.admin_ids:
            for f in files:
                if f.exists():
                    try:
                        await bot.send_document(aid, FSInputFile(f, filename=f.name))
                    except Exception:  # noqa: BLE001
                        log.exception("print file to admin failed")
    await bot.send_message(uid, "Rahmat! Yana xizmat kerak bo'lsa tanlang:", reply_markup=ui.main_menu())
    await db.update_order(order_id, status="delivered")
