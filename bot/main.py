"""Botni ishga tushirish: python main.py"""
from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage

from app.config import config
from app.db import db
from app.handlers import admin, math, order, payment, subscription
from app.payments.userbot import start_userbot


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not config.bot_token:
        raise SystemExit("BOT_TOKEN .env da ko'rsatilmagan")
    await db.connect()

    bot = Bot(config.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=MemoryStorage())
    mw = subscription.SubscriptionMiddleware()
    dp.message.outer_middleware(mw)
    dp.callback_query.outer_middleware(mw)
    # Tartib muhim: admin → obuna tekshiruvi → matematika → to'lov → umumiy buyurtma oqimi
    dp.include_routers(admin.router, subscription.router, math.router, payment.router, order.router)

    userbot = await start_userbot(db)
    try:
        await dp.start_polling(bot)
    finally:
        if userbot:
            await userbot.disconnect()
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
