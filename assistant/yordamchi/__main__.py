"""Ishga tushirish:

    python -m yordamchi login   # birinchi marta: Telegram akkauntga kirish (userbot)
    python -m yordamchi check   # sozlamalar va AI ni tekshirish
    python -m yordamchi         # bot + userbot + web + eslatmalar (doimiy ishlaydi)
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .config import load_config


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "telethon", "aiogram.event", "google_genai", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


async def run(cfg) -> None:
    from .agent import Agent
    from .ai import build_ai
    from .bot import AssistantBot
    from .db import Database
    from .scheduler import Scheduler
    from .store import MessageStore

    log = logging.getLogger("yordamchi")
    cfg.ensure_dirs()
    db = Database(cfg.main_db_path)
    store = MessageStore(cfg.archive_db_path) if cfg.reads_chats else None
    ai = build_ai(cfg)
    log.info("AI: %s", ai.names)
    agent = Agent(cfg, db, store, ai)
    bot = AssistantBot(cfg, agent, ai)
    if bot.business:
        log.info("Telegram Business rejimi yoqilgan — botni Sozlamalar → Telegram Business → Chatbotlar orqali ulang")

    userbot = None
    jobs = [bot.run()]
    if cfg.userbot_enabled and store is not None:
        from .userbot import Userbot
        userbot = Userbot(cfg, db, store, ai)
        if await userbot.start():
            jobs.append(userbot.run_forever())
        else:
            userbot = None
    jobs.append(Scheduler(agent, bot.send, userbot).run())
    if cfg.web_enabled:
        from .web.server import make_server
        jobs.append(make_server(agent).serve())

    tasks = [asyncio.create_task(j) for j in jobs]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows
            pass
    waiter = asyncio.create_task(stop.wait())
    done, _ = await asyncio.wait([*tasks, waiter], return_when=asyncio.FIRST_COMPLETED)
    for t in done:
        if t is not waiter and t.exception():
            log.error("Komponent to'xtadi: %r", t.exception())
    log.info("To'xtatilmoqda…")
    for t in tasks:
        t.cancel()
    if userbot:
        await userbot.stop()
    await bot.bot.session.close()


async def check(cfg) -> int:
    from .ai import build_ai

    problems = cfg.problems()
    for p in problems:
        print(f"❌ {p}")
    if not cfg.gemini_api_key and not cfg.openai_api_key:
        return 1
    ai = build_ai(cfg)
    for p in ai.providers:
        try:
            r = await p.text("Faqat 'ok' deb javob ber.", ["ping"])
            print(f"✅ {p.name}: {r.strip()[:40]}")
        except Exception as e:  # noqa: BLE001
            print(f"❌ {p.name}: {e}")
    if cfg.userbot_enabled and cfg.api_id:
        from .userbot import make_client
        c = make_client(cfg)
        await c.connect()
        ok = await c.is_user_authorized()
        print("✅ Userbot sessiyasi bor" if ok else "❌ Userbot sessiyasi yo'q — `python -m yordamchi login` ni bajaring")
        await c.disconnect()
    if cfg.business_enabled:
        print("ℹ️  Telegram Business rejimi yoqilgan: BotFather → Business Mode → Turn on, so'ng "
              "Sozlamalar → Telegram Business → Chatbotlar orqali botni ulang")
    if not problems:
        print("✅ Sozlamalar to'liq")
    return 1 if problems else 0


def main() -> None:
    ap = argparse.ArgumentParser(prog="yordamchi", description="Telegram shaxsiy AI yordamchi")
    ap.add_argument("command", nargs="?", default="run", choices=["run", "login", "check"])
    ap.add_argument("--env", default=".env", help=".env fayl yo'li")
    ap.add_argument("--log", default="INFO")
    args = ap.parse_args()
    setup_logging(args.log)
    cfg = load_config(args.env)

    if args.command == "login":
        if not cfg.api_id or not cfg.api_hash:
            sys.exit("TG_API_ID va TG_API_HASH ni .env ga yozing (https://my.telegram.org → API development tools)")
        from .userbot import interactive_login
        asyncio.run(interactive_login(cfg))
        return
    if args.command == "check":
        sys.exit(asyncio.run(check(cfg)))

    problems = cfg.problems()
    if problems:
        print("Sozlamalarda kamchilik bor:\n  - " + "\n  - ".join(problems))
        print("\n.env.example faylidan nusxa olib, .env faylini to'ldiring.")
        sys.exit(1)
    try:
        asyncio.run(run(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
