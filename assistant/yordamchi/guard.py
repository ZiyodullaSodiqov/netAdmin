"""Userbot uchun "faqat o'qish" himoyasi.

Telegram akkauntingiz orqali hech qanday yozish amali (xabar yuborish, tahrirlash, o'chirish,
forward, reaksiya, "o'qildi" belgisi, "yozmoqda..." holati, guruhga qo'shilish va h.k.) bajarilmasligi
uchun barcha MTProto so'rovlari oq ro'yxat (allowlist) orqali tekshiriladi.
"""
from __future__ import annotations

import re

# Butunlay ruxsat berilgan modullar: login (auth) — kirish uchun kerak.
_ALLOWED_MODULES = {"auth"}

# Faqat o'qiydigan so'rovlar nomlari shu so'zlar bilan boshlanadi.
_READ_PREFIXES = re.compile(r"^(Get|Search|Resolve|Check|Ping|InvokeWith|InitConnection|DestroySession)")

# Ichki/xizmat so'rovlari (yozish emas): CDN orqali fayl yuklab olish.
_EXTRA_ALLOWED = {"ReuploadCdnFileRequest"}


class WriteBlockedError(PermissionError):
    pass


def _module(req: object) -> str:
    return type(req).__module__.rsplit(".", 1)[-1]


def is_allowed(req: object) -> bool:
    name = type(req).__name__
    if _module(req) in _ALLOWED_MODULES:
        return True
    if name in _EXTRA_ALLOWED:
        return True
    return bool(_READ_PREFIXES.match(name))


def check_request(req: object) -> None:
    reqs = req if isinstance(req, (list, tuple)) else [req]
    for r in reqs:
        if not is_allowed(r):
            raise WriteBlockedError(
                f"Userbot faqat o'qish rejimida: {type(r).__module__}.{type(r).__name__} bloklandi")
