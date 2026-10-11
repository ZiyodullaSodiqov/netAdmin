"""OpenAI va Gemini bilan ishlash uchun yupqa qatlam.

Hammasi JSON qaytaradi — keyin generatorlar undan fayl yasaydi.
"""
from __future__ import annotations

import json
import logging
import re

from ..config import config

log = logging.getLogger(__name__)

_openai = None
_gemini = None


def _openai_client():
    global _openai
    if _openai is None:
        from openai import AsyncOpenAI
        _openai = AsyncOpenAI(api_key=config.openai_api_key)
    return _openai


def _gemini_client():
    global _gemini
    if _gemini is None:
        from google import genai
        _gemini = genai.Client(api_key=config.gemini_api_key)
    return _gemini


def parse_json(text: str):
    """Model javobidan JSON ajratib olish (```json ... ``` bo'lsa ham)."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
        if start < 0:
            raise
        end = max(text.rfind("}"), text.rfind("]"))
        return json.loads(text[start:end + 1])


async def openai_json(system: str, user: str, temperature: float = 0.7) -> dict:
    resp = await _openai_client().chat.completions.create(
        model=config.openai_model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return parse_json(resp.choices[0].message.content or "{}")


async def gemini_json(prompt: str, images: list[tuple[bytes, str]] | None = None,
                      temperature: float = 0.4) -> dict:
    from google.genai import types
    parts: list = [types.Part.from_bytes(data=b, mime_type=m) for b, m in (images or [])]
    parts.append(prompt)
    resp = await _gemini_client().aio.models.generate_content(
        model=config.gemini_model,
        contents=parts,
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=temperature),
    )
    return parse_json(resp.text or "{}")


async def gemini_image(prompt: str) -> bytes | None:
    """Gemini orqali rasm (fon/bezak) generatsiya qilish. Bo'lmasa None."""
    if not config.gemini_api_key:
        return None
    from google.genai import types
    try:
        resp = await _gemini_client().aio.models.generate_content(
            model=config.gemini_image_model,
            contents=[prompt],
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
        for cand in resp.candidates or []:
            for part in (cand.content.parts if cand.content else []) or []:
                if part.inline_data and part.inline_data.data:
                    return part.inline_data.data
    except Exception:  # noqa: BLE001 — fon bo'lmasa ham dizayn chiqadi
        log.exception("Gemini image generation failed")
    return None
