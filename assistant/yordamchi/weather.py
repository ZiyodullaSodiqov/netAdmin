"""Ob-havo: Open-Meteo (bepul, API kalit talab qilmaydi)."""
from __future__ import annotations

import logging
import time as _time
from typing import Any

import httpx

log = logging.getLogger(__name__)

CODES = {
    0: ("☀️", "ochiq osmon"), 1: ("🌤", "asosan ochiq"), 2: ("⛅", "qisman bulutli"), 3: ("☁️", "bulutli"),
    45: ("🌫", "tuman"), 48: ("🌫", "qirovli tuman"),
    51: ("🌦", "yengil shivalama"), 53: ("🌦", "shivalama"), 55: ("🌧", "kuchli shivalama"),
    56: ("🌧", "muzli shivalama"), 57: ("🌧", "kuchli muzli shivalama"),
    61: ("🌦", "yengil yomg'ir"), 63: ("🌧", "yomg'ir"), 65: ("🌧", "kuchli yomg'ir"),
    66: ("🌧", "muzli yomg'ir"), 67: ("🌧", "kuchli muzli yomg'ir"),
    71: ("🌨", "yengil qor"), 73: ("🌨", "qor"), 75: ("❄️", "kuchli qor"), 77: ("🌨", "qor donachalari"),
    80: ("🌦", "qisqa yomg'ir"), 81: ("🌧", "jala"), 82: ("⛈", "kuchli jala"),
    85: ("🌨", "qisqa qor"), 86: ("❄️", "kuchli qor yog'ishi"),
    95: ("⛈", "momaqaldiroq"), 96: ("⛈", "do'l bilan momaqaldiroq"), 99: ("⛈", "kuchli do'l va momaqaldiroq"),
}

_cache: dict[str, tuple[float, dict]] = {}


def describe(code: int | None) -> tuple[str, str]:
    return CODES.get(int(code or 0), ("🌡", "noma'lum"))


async def fetch(lat: float, lon: float, tz: str, ttl: int = 900) -> dict[str, Any]:
    key = f"{lat},{lon},{tz}"
    hit = _cache.get(key)
    if hit and _time.time() - hit[0] < ttl:
        return hit[1]
    params = {
        "latitude": lat, "longitude": lon, "timezone": tz, "forecast_days": 3,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                 "wind_speed_10m_max,sunrise,sunset",
    }
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://api.open-meteo.com/v1/forecast", params=params)
        r.raise_for_status()
        raw = r.json()
    cur = raw.get("current", {})
    daily = raw.get("daily", {})
    days = []
    for i, d in enumerate(daily.get("time", [])):
        icon, text = describe(daily["weather_code"][i])
        days.append({
            "date": d, "icon": icon, "text": text,
            "tmax": round(daily["temperature_2m_max"][i]), "tmin": round(daily["temperature_2m_min"][i]),
            "rain": daily.get("precipitation_probability_max", [None] * (i + 1))[i],
            "wind": round(daily["wind_speed_10m_max"][i]),
            "sunrise": (daily.get("sunrise") or [""] * (i + 1))[i][-5:],
            "sunset": (daily.get("sunset") or [""] * (i + 1))[i][-5:],
        })
    icon, text = describe(cur.get("weather_code"))
    data = {
        "current": {
            "temp": round(cur.get("temperature_2m", 0)), "feels": round(cur.get("apparent_temperature", 0)),
            "icon": icon, "text": text, "wind": round(cur.get("wind_speed_10m", 0)),
            "humidity": cur.get("relative_humidity_2m"),
        },
        "days": days,
    }
    _cache[key] = (_time.time(), data)
    return data


def advice(day: dict) -> str:
    tips = []
    if (day.get("rain") or 0) >= 50:
        tips.append("soyabon olib oling ☔")
    if day["tmin"] <= 0:
        tips.append("issiq kiyining 🧥")
    elif day["tmax"] >= 35:
        tips.append("ko'proq suv iching 💧")
    if day["wind"] >= 30:
        tips.append("kuchli shamol bo'ladi 🌬")
    return ", ".join(tips)


def format_brief(city: str, w: dict) -> str:
    c = w["current"]
    t = w["days"][0] if w["days"] else None
    lines = [f"{c['icon']} <b>{city}</b>: hozir {c['temp']}°C ({c['text']}), his qilinishi {c['feels']}°C"]
    if t:
        rain = f", yog'ingarchilik ehtimoli {t['rain']}%" if t.get("rain") is not None else ""
        lines.append(f"Bugun: {t['tmin']}°…{t['tmax']}°C, {t['text']}{rain}, shamol {t['wind']} km/soat")
        tip = advice(t)
        if tip:
            lines.append(f"💡 {tip.capitalize()}")
    if len(w["days"]) > 1:
        n = w["days"][1]
        lines.append(f"Ertaga: {n['icon']} {n['tmin']}°…{n['tmax']}°C, {n['text']}")
    return "\n".join(lines)
