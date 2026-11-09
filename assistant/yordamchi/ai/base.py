"""AI provayderlar uchun umumiy interfeys va zaxira (fallback) mexanizmi."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Sequence, Union

log = logging.getLogger(__name__)


@dataclass
class Blob:
    """Fayl (rasm, PDF, audio) — multimodal so'rovlar uchun."""
    data: bytes
    mime: str
    name: str = "file"


Part = Union[str, Blob]


class AIError(RuntimeError):
    pass


class Provider:
    name = "base"

    async def text(self, system: str, parts: Sequence[Part], json_mode: bool = False) -> str:
        raise NotImplementedError

    async def transcribe(self, data: bytes, mime: str, filename: str = "audio.ogg") -> str:
        raise NotImplementedError

    def supports(self, mime: str) -> bool:
        return True


def parse_json(raw: str) -> Any:
    """Model javobidan JSON ni ajratib oladi (```json ... ``` bo'lsa ham)."""
    s = raw.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if m:
        s = m.group(1).strip()
    try:
        return json.loads(s)
    except ValueError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = s.find(open_c), s.rfind(close_c)
        if a != -1 and b > a:
            try:
                return json.loads(s[a:b + 1])
            except ValueError:
                continue
    raise AIError(f"AI javobi JSON emas: {raw[:200]}")


class AI:
    """Asosiy provayder ishlamasa — avtomatik ravishda zaxira provayderga o'tadi."""

    def __init__(self, providers: list[Provider]):
        if not providers:
            raise AIError("Hech qanday AI provayder sozlanmagan (GEMINI_API_KEY yoki OPENAI_API_KEY)")
        self.providers = providers

    @property
    def names(self) -> str:
        return " → ".join(p.name for p in self.providers)

    async def _try(self, fn_name: str, *args: Any, mime: str | None = None, **kw: Any) -> Any:
        errors = []
        for p in self.providers:
            if mime and not p.supports(mime):
                continue
            try:
                return await getattr(p, fn_name)(*args, **kw)
            except NotImplementedError:
                continue
            except Exception as e:  # noqa: BLE001
                log.warning("AI provayder %s xato berdi (%s): %s", p.name, fn_name, e)
                errors.append(f"{p.name}: {e}")
        raise AIError("; ".join(errors) or f"{fn_name} uchun mos provayder yo'q")

    async def text(self, system: str, parts: Sequence[Part] | str) -> str:
        if isinstance(parts, str):
            parts = [parts]
        mime = next((p.mime for p in parts if isinstance(p, Blob)), None)
        return (await self._try("text", system, list(parts), mime=mime)).strip()

    async def json(self, system: str, parts: Sequence[Part] | str) -> Any:
        if isinstance(parts, str):
            parts = [parts]
        mime = next((p.mime for p in parts if isinstance(p, Blob)), None)
        errors = []
        for p in self.providers:
            if mime and not p.supports(mime):
                continue
            try:
                return parse_json(await p.text(system, list(parts), json_mode=True))
            except Exception as e:  # noqa: BLE001
                log.warning("AI provayder %s JSON xatosi: %s", p.name, e)
                errors.append(f"{p.name}: {e}")
        raise AIError("; ".join(errors) or "mos provayder yo'q")

    async def transcribe(self, data: bytes, mime: str, filename: str = "audio.ogg") -> str:
        return (await self._try("transcribe", data, mime, filename)).strip()


def build_ai(cfg: Any) -> AI:
    from .gemini import GeminiProvider
    from .openai_provider import OpenAIProvider

    available: dict[str, Provider] = {}
    if cfg.gemini_api_key:
        available["gemini"] = GeminiProvider(cfg.gemini_api_key, cfg.gemini_model)
    if cfg.openai_api_key:
        available["openai"] = OpenAIProvider(cfg.openai_api_key, cfg.openai_model, cfg.openai_transcribe_model)
    order = [cfg.ai_provider] + [n for n in ("gemini", "openai") if n != cfg.ai_provider]
    providers = [available[n] for n in order if n in available]
    if not cfg.ai_fallback:
        providers = providers[:1]
    return AI(providers)
