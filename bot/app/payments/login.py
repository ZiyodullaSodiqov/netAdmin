"""Bir martalik: userbot uchun TG_SESSION_STRING olish.

    python -m app.payments.login

Telefon raqam va Telegram yuborgan kodni kiriting, chiqqan satrni .env dagi TG_SESSION_STRING ga qo'ying.
Bu satr akkauntingizga kirish kaliti — hech kimga bermang.
"""
from telethon.sessions import StringSession
from telethon.sync import TelegramClient

from ..config import config

if __name__ == "__main__":
    with TelegramClient(StringSession(), config.tg_api_id, config.tg_api_hash) as client:
        print("\nTG_SESSION_STRING=" + client.session.save())
