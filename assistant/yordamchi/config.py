"""Sozlamalar: .env fayl yoki muhit o'zgaruvchilaridan o'qiladi."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "ha", "on")


def _int(v: str | None, default: int = 0) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _float(v: str | None, default: float) -> float:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


@dataclass
class Config:
    # Telegram bot (yordamchi bilan muloqot uchun)
    bot_token: str = ""
    owner_id: int = 0

    # Telegram Business: bot akkaunt sozlamalaridan ulanadi (API ID kerak emas, Premium kerak)
    business_enabled: bool = True

    # Telegram userbot (o'z akkauntingiz — faqat o'qish, my.telegram.org API ID/HASH kerak)
    userbot_enabled: bool = False
    api_id: int = 0
    api_hash: str = ""
    phone: str = ""

    # AI
    ai_provider: str = "gemini"  # gemini | openai
    ai_fallback: bool = True
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_transcribe_model: str = "whisper-1"

    # Vaqt va ob-havo
    timezone: str = "Asia/Tashkent"
    daily_brief_time: str = "08:00"
    default_task_time: str = "09:00"
    reminder_offsets: list[int] = field(default_factory=lambda: [1440, 60, 15, 0])
    weather_city: str = "Toshkent"
    weather_lat: float = 41.3111
    weather_lon: float = 69.2797

    # Web
    web_enabled: bool = True
    web_host: str = "127.0.0.1"
    web_port: int = 8080
    web_token: str = ""

    # Ma'lumotlar
    data_dir: Path = Path("data")
    store_media: bool = False
    store_media_max_mb: int = 20
    history_backfill: int = 200
    daily_sync_time: str = "08:00"

    # Chatlarni tahlil qilish
    chat_task_detection: bool = True
    chat_scan_interval_min: int = 15
    chat_scan_groups: bool = False
    transcribe_chat_voices: bool = False

    @property
    def reads_chats(self) -> bool:
        return self.business_enabled or self.userbot_enabled

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def main_db_path(self) -> Path:
        return self.data_dir / "assistant.db"

    @property
    def archive_db_path(self) -> Path:
        return self.data_dir / "archive.db"

    @property
    def session_path(self) -> Path:
        return self.data_dir / "userbot"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def docs_dir(self) -> Path:
        return self.data_dir / "documents"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.media_dir, self.docs_dir):
            p.mkdir(parents=True, exist_ok=True)

    def problems(self) -> list[str]:
        out = []
        if not self.bot_token:
            out.append("TELEGRAM_BOT_TOKEN ko'rsatilmagan")
        if not self.owner_id:
            out.append("OWNER_ID ko'rsatilmagan (o'zingizning Telegram ID raqamingiz)")
        if self.userbot_enabled and (not self.api_id or not self.api_hash):
            out.append("USERBOT_ENABLED=true, lekin TG_API_ID / TG_API_HASH yo'q (my.telegram.org) — "
                       "yoki USERBOT_ENABLED=false qilib, Telegram Business rejimidan foydalaning")
        if not self.gemini_api_key and not self.openai_api_key:
            out.append("GEMINI_API_KEY yoki OPENAI_API_KEY dan kamida bittasi kerak")
        return out


def load_config(env_file: str | os.PathLike | None = None) -> Config:
    if load_dotenv is not None:
        load_dotenv(env_file or ".env", override=False)
    e = os.environ.get
    offsets = [
        _int(x, -1) for x in (e("REMINDER_OFFSETS") or "1440,60,15,0").split(",") if x.strip()
    ]
    offsets = sorted({o for o in offsets if o >= 0}, reverse=True) or [0]
    return Config(
        bot_token=e("TELEGRAM_BOT_TOKEN", ""),
        owner_id=_int(e("OWNER_ID")),
        business_enabled=_bool(e("BUSINESS_ENABLED"), True),
        userbot_enabled=_bool(e("USERBOT_ENABLED"), False),
        api_id=_int(e("TG_API_ID")),
        api_hash=e("TG_API_HASH", ""),
        phone=e("TG_PHONE", ""),
        ai_provider=(e("AI_PROVIDER") or "gemini").strip().lower(),
        ai_fallback=_bool(e("AI_FALLBACK"), True),
        gemini_api_key=e("GEMINI_API_KEY", ""),
        gemini_model=e("GEMINI_MODEL") or "gemini-2.5-flash",
        openai_api_key=e("OPENAI_API_KEY", ""),
        openai_model=e("OPENAI_MODEL") or "gpt-4.1-mini",
        openai_transcribe_model=e("OPENAI_TRANSCRIBE_MODEL") or "whisper-1",
        timezone=e("TIMEZONE") or "Asia/Tashkent",
        daily_brief_time=e("DAILY_BRIEF_TIME") or "08:00",
        default_task_time=e("DEFAULT_TASK_TIME") or "09:00",
        reminder_offsets=offsets,
        weather_city=e("WEATHER_CITY") or "Toshkent",
        weather_lat=_float(e("WEATHER_LAT"), 41.3111),
        weather_lon=_float(e("WEATHER_LON"), 69.2797),
        web_enabled=_bool(e("WEB_ENABLED"), True),
        web_host=e("WEB_HOST") or "127.0.0.1",
        web_port=_int(e("WEB_PORT"), 8080),
        web_token=e("WEB_TOKEN", ""),
        data_dir=Path(e("DATA_DIR") or "data"),
        store_media=_bool(e("STORE_MEDIA"), False),
        store_media_max_mb=_int(e("STORE_MEDIA_MAX_MB"), 20),
        history_backfill=_int(e("HISTORY_BACKFILL"), 200),
        daily_sync_time=e("DAILY_SYNC_TIME") or "08:00",
        chat_task_detection=_bool(e("CHAT_TASK_DETECTION"), True),
        chat_scan_interval_min=max(1, _int(e("CHAT_SCAN_INTERVAL_MIN"), 15)),
        chat_scan_groups=_bool(e("CHAT_SCAN_GROUPS"), False),
        transcribe_chat_voices=_bool(e("TRANSCRIBE_CHAT_VOICES"), False),
    )
