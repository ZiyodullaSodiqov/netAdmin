"""Mijoz uchun natijalarni ko'rish sahifasi: /p/<token>.

Himoya: havola tasodifiy va muddatli; rasmlar suv belgili (foydalanuvchi ID si bilan), kichraytirilgan,
2-3-sahifalarning pasti xiralashtirilgan; rasmlar <img> emas, canvas'ga chiziladi; o'ng tugma, sudrash,
belgilash, Ctrl+S/P/C, chop etish bloklangan; oyna fokusni yo'qotsa (skrinshot dasturi ochilsa) sahifa xiralashadi.
Eslatma: ekrandagi tasvirni telefon kamerasi bilan suratga olishni hech bir sayt to'liq to'xtata olmaydi —
shuning uchun asosiy himoya — suv belgisi va past sifat.
"""
from __future__ import annotations

import html
from pathlib import Path

from aiohttp import web

from ..db import db
from ..services import SERVICES

e = html.escape

PAGE_CSS = """
*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
body{margin:0;background:#0f1218;color:#e5e7eb;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:18px 16px 6px;max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}
.muted{color:#9aa3b2}.wrap{max-width:1100px;margin:0 auto;padding:8px 16px 40px}
.v{background:#171b23;border:1px solid #262c38;border-radius:14px;padding:14px;margin:14px 0}
.v h2{font-size:17px;margin:0 0 10px;display:flex;justify-content:space-between;align-items:center}
.pages{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
canvas{background:#fff;border-radius:6px;height:min(52vh,360px);width:auto;flex:none;pointer-events:none}
.badge{font-size:13px;background:#1c2740;color:#6b9cff;padding:2px 10px;border-radius:99px}
.cta{display:inline-block;margin-top:10px;background:#2563eb;color:#fff;padding:10px 18px;border-radius:10px;
text-decoration:none;font-weight:600}
#shield{position:fixed;inset:0;background:#0f1218;display:none;align-items:center;justify-content:center;
font-size:18px;z-index:9;text-align:center;padding:20px}
body.hide #shield{display:flex}body.hide .wrap{filter:blur(30px)}
@media print{body{display:none!important}}
"""

PAGE_JS = """
(function(){
  const stop = e => { e.preventDefault(); return false; };
  ['contextmenu','dragstart','copy','cut','selectstart'].forEach(t => document.addEventListener(t, stop));
  document.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['s','p','c','u','a'].includes(k)) stop(e);
    if (k === 'printscreen' || e.keyCode === 44) {
      document.body.classList.add('hide');
      try { navigator.clipboard.writeText(''); } catch (_) {}
    }
  });
  const hide = () => document.body.classList.add('hide');
  const show = () => document.body.classList.remove('hide');
  window.addEventListener('blur', hide); window.addEventListener('focus', show);
  document.addEventListener('visibilitychange', () => document.hidden ? hide() : show());
  document.querySelectorAll('canvas[data-src]').forEach(async c => {
    try {
      const r = await fetch(c.dataset.src, {cache: 'no-store', credentials: 'same-origin'});
      const bmp = await createImageBitmap(await r.blob());
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      c.removeAttribute('data-src');
    } catch (_) {}
  });
})();
"""

NO_STORE = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache", "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff"}


async def _order_or_404(token: str) -> dict:
    order = await db.preview_order(token)
    if not order or order["status"] not in ("draft", "awaiting_payment"):
        raise web.HTTPNotFound(text="Havola eskirgan yoki topilmadi. Botdan qaytadan oling.", headers=NO_STORE)
    return order


async def preview_page(req: web.Request) -> web.Response:
    token = req.match_info["token"]
    order = await _order_or_404(token)
    from .server import BOT  # aylanma importdan qochish
    me = await req.app[BOT].me()
    files = order["params"].get("preview_files") or []
    svc = SERVICES.get(order["service"])
    blocks = []
    for vi, pages in enumerate(files):
        canv = "".join(f'<canvas data-src="/p/{e(token)}/img/{vi + 1}/{ni + 1}" width="300" height="420"></canvas>'
                       for ni in range(len(pages)))
        blocks.append(f'<section class="v"><h2>{vi + 1}-uslub <span class="badge">Botda «✅ {vi + 1}-uslub» '
                      f'ni bosing</span></h2><div class="pages">{canv}</div></section>')
    body = (f'<header><h1>{e(svc.title if svc else "Natija")} — {len(files)} xil uslub</h1>'
            f'<div class="muted">Bu namunalar: suv belgili va past sifatli. Yoqqan uslubni botda tanlab, '
            f'to\'lovdan so\'ng asl faylni olasiz.</div>'
            f'<a class="cta" href="https://t.me/{e(me.username or "")}">⬅️ Botga qaytish va tanlash</a></header>'
            f'<div class="wrap">{"".join(blocks)}</div>'
            f'<div id="shield">🔒 Namunani ko\'rish uchun sahifaga qayting</div>')
    html_doc = (f'<!doctype html><html lang="uz"><head><meta charset="utf-8">'
                f'<meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<meta name="robots" content="noindex,nofollow"><title>Namunalar</title>'
                f'<style>{PAGE_CSS}</style></head><body>{body}<script>{PAGE_JS}</script></body></html>')
    headers = {**NO_STORE, "Content-Security-Policy":
               "default-src 'none'; img-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; "
               "script-src 'unsafe-inline'; frame-ancestors 'none'"}
    return web.Response(text=html_doc, content_type="text/html", headers=headers)


async def preview_image(req: web.Request) -> web.StreamResponse:
    order = await _order_or_404(req.match_info["token"])
    v, n = int(req.match_info["v"]), int(req.match_info["n"])
    files = order["params"].get("preview_files") or []
    if not (1 <= v <= len(files) and 1 <= n <= len(files[v - 1])):
        raise web.HTTPNotFound(headers=NO_STORE)
    path = Path(files[v - 1][n - 1])
    if not path.exists():
        raise web.HTTPNotFound(headers=NO_STORE)
    return web.Response(body=path.read_bytes(), content_type="image/jpeg",
                        headers={**NO_STORE, "Content-Disposition": "inline"})
