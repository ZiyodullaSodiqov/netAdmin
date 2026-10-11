"""OpenAI bilan ishlash uchun yupqa qatlam: matn, rasmni o'qish (vision), rasm yaratish va tahrirlash."""
from __future__ import annotations

import base64
import json
import logging
import re

from ..config import config

log = logging.getLogger(__name__)

_openai = None


def _client():
    global _openai
    if _openai is None:
        from openai import AsyncOpenAI
        _openai = AsyncOpenAI(api_key=config.openai_api_key)
    return _openai


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
    resp = await _client().chat.completions.create(
        model=config.openai_model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return parse_json(resp.choices[0].message.content or "{}")


async def vision_json(prompt: str, images: list[tuple[bytes, str]] | None = None,
                      temperature: float = 0.2) -> dict:
    """Rasm(lar) + ko'rsatma → JSON. Rasm bo'lmasa oddiy matnli so'rov."""
    content: list[dict] = [{"type": "text", "text": prompt + "\nJavobni faqat JSON ko'rinishida qaytar."}]
    for data, mime in images or []:
        url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        content.append({"type": "image_url", "image_url": {"url": url, "detail": "high"}})
    resp = await _client().chat.completions.create(
        model=config.openai_vision_model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": content}],
    )
    return parse_json(resp.choices[0].message.content or "{}")


async def generate_image(prompt: str, size: str = "1536x1024") -> bytes | None:
    """Matndan rasm (fon/bezak). Xatolik bo'lsa None — dizayn oddiy fon bilan chiqadi."""
    if not config.openai_api_key:
        return None
    try:
        resp = await _client().images.generate(model=config.openai_image_model, prompt=prompt, size=size,
                                               quality=config.openai_image_quality, n=1)
        return base64.b64decode(resp.data[0].b64_json)
    except Exception:  # noqa: BLE001
        log.exception("OpenAI image generation failed")
        return None


async def edit_image(image: bytes, prompt: str, size: str = "1024x1536") -> bytes:
    """Mavjud rasmni tahrirlash (masalan, kiyimni almashtirish). Yuz o'zgarmasligi uchun input_fidelity=high."""
    resp = await _client().images.edit(
        model=config.openai_image_model, image=("photo.png", image, "image/png"), prompt=prompt, size=size,
        quality=config.openai_image_quality, input_fidelity="high", n=1)
    return base64.b64decode(resp.data[0].b64_json)
