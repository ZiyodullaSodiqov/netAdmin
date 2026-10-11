"""Admin buyruqlari: /stats, /payments (oxirgi karta kirimlari), /confirm <id>."""
from __future__ import annotations

import html

from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import Message

from ..config import config
from ..db import db
from ..delivery import deliver, order_total

router = Router()
router.message.filter(F.from_user.id.in_(set(config.admin_ids)))


@router.message(Command("stats"))
async def stats(msg: Message):
    rows = await db._all("SELECT status, COUNT(*) n, COALESCE(SUM(price + print_price*with_print),0) s "
                         "FROM orders GROUP BY status")
    users = await db._one("SELECT COUNT(*) n FROM users")
    lines = [f"👥 Foydalanuvchilar: {users['n']}"] + [f"{r['status']}: {r['n']} ta, {r['s']} so'm" for r in rows]
    await msg.answer("\n".join(lines))


@router.message(Command("payments"))
async def payments(msg: Message):
    rows = await db._all("SELECT * FROM card_payments ORDER BY id DESC LIMIT 15")
    if not rows:
        await msg.answer("Karta kirimlari hali yo'q. Userbot ishlayaptimi?")
        return
    await msg.answer("\n".join(
        f"#{r['id']} {r['amount']} so'm — {r['paid_at'][:16]} — *{r['card_last4'] or '----'} — "
        f"{'buyurtma #' + str(r['order_id']) if r['order_id'] else 'bo`sh'}" for r in rows))


@router.message(Command("confirm"))
async def confirm(msg: Message, command: CommandObject, bot: Bot):
    """/confirm 15 — 15-buyurtmani qo'lda to'langan deb belgilash."""
    if not command.args or not command.args.strip().isdigit():
        await msg.answer("Foydalanish: /confirm <buyurtma_id>")
        return
    oid = int(command.args)
    o = await db.get_order(oid)
    if not o or o["status"] != "awaiting_payment":
        await msg.answer("Bunday to'lov kutilayotgan buyurtma yo'q.")
        return
    if await db.confirm_payment(oid, None, None, order_total(o), None):
        await deliver(bot, oid)
        await msg.answer(f"✅ #{oid} tasdiqlandi va yuborildi.")


@router.message(Command("order"))
async def order_info(msg: Message, command: CommandObject):
    if not command.args or not command.args.strip().isdigit():
        await msg.answer("Foydalanish: /order <id>")
        return
    o = await db.get_order(int(command.args))
    if not o:
        await msg.answer("Topilmadi")
        return
    p = {k: v for k, v in o["params"].items() if k not in ("files_out", "files", "work")}
    await msg.answer(f"#{o['id']} {o['service']} — {o['status']}\nJami: {order_total(o)}\n"
                     f"<code>{html.escape(str(p))[:3000]}</code>")
