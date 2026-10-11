"""Muhit o'zgaruvchilaridan sozlamalarni o'qish."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _list(name: str) -> list[str]:
    return [x.strip() for x in os.getenv(name, "").split(",") if x.strip()]


def _int(name: str, default: int) -> int:
    v = os.getenv(name, "").strip()
    return int(v) if v else default


@dataclass
class Config:
    bot_token: str = os.getenv("BOT_TOKEN", "")
    admin_ids: list[int] = field(default_factory=lambda: [int(x) for x in _list("ADMIN_IDS")])
    required_channels: list[str] = field(default_factory=lambda: _list("REQUIRED_CHANNELS"))

    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    openai_vision_model: str = os.getenv("OPENAI_VISION_MODEL", "") or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    openai_image_model: str = os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-1")
    openai_image_quality: str = os.getenv("OPENAI_IMAGE_QUALITY", "high")

    card_number: str = os.getenv("CARD_NUMBER", "")
    card_owner: str = os.getenv("CARD_OWNER", "")
    notify_bot_username: str = os.getenv("NOTIFY_BOT_USERNAME", "").lstrip("@")
    tg_api_id: int = _int("TG_API_ID", 0)
    tg_api_hash: str = os.getenv("TG_API_HASH", "")
    tg_session_string: str = os.getenv("TG_SESSION_STRING", "")
    payment_time_tolerance_min: int = _int("PAYMENT_TIME_TOLERANCE_MIN", 5)
    payment_max_age_min: int = _int("PAYMENT_MAX_AGE_MIN", 120)
    payment_wait_sec: int = _int("PAYMENT_WAIT_SEC", 90)
    tz_offset_hours: int = _int("TZ_OFFSET_HOURS", 5)

    db_path: str = os.getenv("DB_PATH", "data/bot.db")
    work_dir: Path = Path(os.getenv("WORK_DIR", "data/files"))

    font_regular: str = os.getenv("FONT_REGULAR", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    font_bold: str = os.getenv("FONT_BOLD", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    font_serif: str = os.getenv("FONT_SERIF", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf")
    font_serif_bold: str = os.getenv("FONT_SERIF_BOLD", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf")

    # --- Web admin panel ---
    web_host: str = os.getenv("WEB_HOST", "0.0.0.0")
    web_port: int = _int("WEB_PORT", 8080)
    web_admin_password: str = os.getenv("WEB_ADMIN_PASSWORD", "")
    web_secret: str = os.getenv("WEB_SECRET", "")
    web_public_url: str = os.getenv("WEB_PUBLIC_URL", "")
    # «Admin bilan bog'lanish» da ko'rsatiladigan username (masalan @admin); bo'sh bo'lsa faqat bot orqali
    admin_contact: str = os.getenv("ADMIN_CONTACT", "")

    # Mijozga natija fayllarini zip arxiv qilib yuborish (DELIVER_ZIP=0 — alohida fayllar)
    deliver_zip: bool = os.getenv("DELIVER_ZIP", "1").strip().lower() not in ("0", "false", "no", "off")

    price_tests: int = _int("PRICE_TESTS", 5000)
    # 3x4 rasmda kiyim (kostyum/kofta) kiydirish uchun qo'shimcha narx
    price_photo_clothes: int = _int("PRICE_PHOTO_CLOTHES", 0)

    @property
    def tz(self) -> timezone:
        return timezone(timedelta(hours=self.tz_offset_hours))


config = Config()
config.work_dir.mkdir(parents=True, exist_ok=True)
Path(config.db_path).parent.mkdir(parents=True, exist_ok=True)
