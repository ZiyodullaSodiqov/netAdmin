"""OpenAI provayderi."""
from __future__ import annotations

import base64
from typing import Sequence

from .base import Blob, Part, Provider


class OpenAIProvider(Provider):
    name = "openai"

    def __init__(self, api_key: str, model: str, transcribe_model: str = "whisper-1"):
        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model
        self.transcribe_model = transcribe_model

    def supports(self, mime: str) -> bool:
        # Chat Completions: rasm va PDF qabul qiladi; audio — alohida transkripsiya orqali.
        return mime.startswith("image/") or mime == "application/pdf"

    def _content(self, parts: Sequence[Part]) -> list[dict]:
        out: list[dict] = []
        for p in parts:
            if isinstance(p, Blob):
                b64 = base64.b64encode(p.data).decode()
                if p.mime.startswith("image/"):
                    out.append({"type": "image_url", "image_url": {"url": f"data:{p.mime};base64,{b64}"}})
                elif p.mime == "application/pdf":
                    out.append({"type": "file", "file": {"filename": p.name or "document.pdf",
                                                         "file_data": f"data:application/pdf;base64,{b64}"}})
                else:
                    raise NotImplementedError(p.mime)
            else:
                out.append({"type": "text", "text": str(p)})
        return out

    async def text(self, system: str, parts: Sequence[Part], json_mode: bool = False) -> str:
        kwargs = {}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
            system = system + "\nJavobni faqat JSON formatida ber."
        resp = await self.client.chat.completions.create(
            model=self.model,
            temperature=0.2,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": self._content(parts)}],
            **kwargs,
        )
        return resp.choices[0].message.content or ""

    async def transcribe(self, data: bytes, mime: str, filename: str = "audio.ogg") -> str:
        res = await self.client.audio.transcriptions.create(
            model=self.transcribe_model,
            file=(filename, data, mime or "audio/ogg"),
        )
        return res if isinstance(res, str) else (getattr(res, "text", "") or "")
