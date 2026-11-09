"""Google Gemini provayderi (google-genai SDK)."""
from __future__ import annotations

from typing import Sequence

from .base import Blob, Part, Provider
from .prompts import TRANSCRIBE_PROMPT


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self, api_key: str, model: str):
        from google import genai

        self.client = genai.Client(api_key=api_key)
        self.model = model

    def _parts(self, parts: Sequence[Part]) -> list:
        from google.genai import types

        out: list = []
        for p in parts:
            if isinstance(p, Blob):
                out.append(types.Part.from_bytes(data=p.data, mime_type=p.mime))
            else:
                out.append(str(p))
        return out

    async def text(self, system: str, parts: Sequence[Part], json_mode: bool = False) -> str:
        from google.genai import types

        cfg = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.2,
            response_mime_type="application/json" if json_mode else None,
        )
        resp = await self.client.aio.models.generate_content(model=self.model, contents=self._parts(parts), config=cfg)
        return resp.text or ""

    async def transcribe(self, data: bytes, mime: str, filename: str = "audio.ogg") -> str:
        # Telegram ovozli xabarlari OGG/Opus — Gemini uni to'g'ridan-to'g'ri qabul qiladi.
        return await self.text(TRANSCRIBE_PROMPT, [Blob(data, mime or "audio/ogg"), "Transkripsiya:"])
