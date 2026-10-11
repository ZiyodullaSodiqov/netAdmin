"""Majburiy obuna kanallari: web paneldan o'zgartiriladi (bazada), bo'lmasa .env dagi REQUIRED_CHANNELS."""
from __future__ import annotations

import json

from .config import config
from .db import db

_cache: list[str] | None = None


def normalize(raw: str) -> list[str]:
    out = []
    for part in raw.replace("\n", ",").split(","):
        ch = part.strip()
        if not ch:
            continue
        if ch.startswith("https://t.me/") or ch.startswith("t.me/"):
            ch = "@" + ch.rstrip("/").rsplit("/", 1)[-1]
        if not ch.startswith("@") and not ch.lstrip("-").isdigit():
            ch = "@" + ch
        if ch not in out:
            out.append(ch)
    return out


async def get_channels() -> list[str]:
    global _cache
    if _cache is None:
        raw = await db.get_setting("required_channels")
        _cache = json.loads(raw) if raw is not None else list(config.required_channels)
    return _cache


async def set_channels(channels: list[str]) -> None:
    global _cache
    await db.set_setting("required_channels", json.dumps(channels))
    _cache = list(channels)
