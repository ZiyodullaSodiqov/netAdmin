"""Lokal web sahifa: vazifalar (bajarilgan/bajarilmagan), ob-havo."""
from __future__ import annotations

import contextlib
import hmac
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .. import weather
from ..agent import Agent
from ..db import is_overdue
from ..timeutil import fmt_local, from_db, local_day_bounds

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"


class TaskIn(BaseModel):
    title: str | None = None
    description: str | None = None
    due_date: str | None = None
    due_time: str | None = None
    priority: str | None = None
    assignee: str | None = None
    status: str | None = None
    no_deadline: bool | None = None
    clear_due: bool | None = None


def create_app(agent: Agent) -> FastAPI:
    cfg, db, tz = agent.cfg, agent.db, agent.tz
    app = FastAPI(title="Yordamchi", docs_url=None, redoc_url=None, openapi_url=None)

    def auth(request: Request) -> None:
        if not cfg.web_token:
            return
        tok = request.headers.get("x-token") or request.query_params.get("token") or ""
        if not hmac.compare_digest(tok, cfg.web_token):
            raise HTTPException(401, "token kerak")

    def out(t: dict) -> dict:
        due = from_db(t.get("due_at"))
        loc = due.astimezone(tz) if due else None
        return {
            **{k: t[k] for k in ("id", "title", "description", "status", "priority", "assignee", "people",
                                 "source", "source_chat_title", "has_time", "no_deadline", "created_at",
                                 "completed_at")},
            "due_date": loc.date().isoformat() if loc else None,
            "due_time": f"{loc:%H:%M}" if loc and t["has_time"] else None,
            "due_label": fmt_local(t["due_at"], tz, t["has_time"]) if due else "muddatsiz",
            "overdue": is_overdue(t),
        }

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/api/tasks", dependencies=[Depends(auth)])
    async def tasks(status: str = "open") -> list[dict]:
        today = datetime.now(tz).date()
        if status == "today":
            items = db.list_tasks("open", *local_day_bounds(today, tz))
        elif status == "week":
            s, _ = local_day_bounds(today, tz)
            _, e = local_day_bounds(today + timedelta(days=6), tz)
            items = db.list_tasks("open", s, e)
        elif status == "overdue":
            items = db.list_tasks("open", overdue=True)
        elif status == "done":
            items = sorted(db.list_tasks("done"), key=lambda t: t.get("completed_at") or "", reverse=True)
        elif status in ("suggested", "cancelled"):
            items = db.list_tasks(status)
        elif status == "all":
            items = db.list_tasks(None, limit=2000)
        else:
            items = db.list_tasks("open", limit=2000)
        return [out(t) for t in items]

    @app.get("/api/stats", dependencies=[Depends(auth)])
    async def stats() -> dict:
        s = db.stats()
        today = datetime.now(tz).date()
        s["today"] = len(db.list_tasks("open", *local_day_bounds(today, tz)))
        s["now"] = datetime.now(tz).isoformat()
        s["city"] = cfg.weather_city
        return s

    @app.get("/api/weather", dependencies=[Depends(auth)])
    async def get_weather() -> Any:
        try:
            return await weather.fetch(cfg.weather_lat, cfg.weather_lon, cfg.timezone) | {"city": cfg.weather_city}
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=502)

    def fields(body: TaskIn, base: dict | None) -> dict:
        raw = body.model_dump(exclude_unset=True)
        item: dict[str, Any] = {k: v for k, v in raw.items() if k in ("title", "description", "priority")}
        if "assignee" in raw:
            item["assignee"] = raw["assignee"] or None
        if "due_date" in raw or "due_time" in raw:
            item["due_date"] = raw.get("due_date") or (out(base)["due_date"] if base else None)
            item["due_time"] = raw.get("due_time") or None
        f = agent._task_fields(item, base=base)
        if raw.get("clear_due"):
            f.update(due_at=None, has_time=0)
        if raw.get("no_deadline") is not None:
            f["no_deadline"] = int(bool(raw["no_deadline"]))
        if raw.get("status") in ("pending", "done", "cancelled"):
            f["status"] = raw["status"]
        return f

    @app.post("/api/tasks", dependencies=[Depends(auth)])
    async def create(body: TaskIn) -> dict:
        if not (body.title or "").strip():
            raise HTTPException(400, "Nom kiriting")
        f = fields(body, None)
        f.setdefault("description", "")
        t = db.add_task(**f, source="web")
        agent.prime_reminders(t)
        return out(t)

    @app.patch("/api/tasks/{tid}", dependencies=[Depends(auth)])
    async def update(tid: int, body: TaskIn) -> dict:
        base = db.get_task(tid)
        if not base:
            raise HTTPException(404)
        t = agent.update_task(tid, **fields(body, base))
        if base["status"] == "suggested" and t and t["status"] == "pending":
            agent.prime_reminders(t)
        return out(t)  # type: ignore[arg-type]

    @app.delete("/api/tasks/{tid}", dependencies=[Depends(auth)])
    async def remove(tid: int) -> dict:
        if not db.delete_task(tid):
            raise HTTPException(404)
        return {"ok": True}

    return app


class _Server:
    """uvicorn ni umumiy asyncio tsiklida (bot va userbot bilan birga) ishga tushiradi."""

    def __init__(self, agent: Agent):
        import uvicorn

        class Server(uvicorn.Server):
            def capture_signals(self):  # signal larni asosiy dastur boshqaradi
                return contextlib.nullcontext()

        self.server = Server(uvicorn.Config(create_app(agent), host=agent.cfg.web_host, port=agent.cfg.web_port,
                                            log_level="warning", access_log=False))

    async def serve(self) -> None:
        log.info("Web sahifa: http://%s:%s", self.server.config.host, self.server.config.port)
        await self.server.serve()


def make_server(agent: Agent) -> _Server:
    return _Server(agent)
