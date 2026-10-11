"""Web panel uchun HTML shablonlar (tashqi kutubxonalarsiz, server tomonda yig'iladi)."""
from __future__ import annotations

import json
from html import escape as e

CSS = """
:root{--bg:#f5f6f8;--card:#fff;--text:#1d2330;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--accent-soft:#e8efff;
--ok:#15803d;--ok-soft:#e7f6ec;--bad:#b91c1c;--bad-soft:#fdecec;--warn:#a16207;--warn-soft:#fdf6e3}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--text:#e5e7eb;--muted:#9aa3b2;--line:#262c38;
--accent:#6b9cff;--accent-soft:#1c2740;--ok:#4ade80;--ok-soft:#14261b;--bad:#f87171;--bad-soft:#2b1717;--warn:#fbbf24;
--warn-soft:#2a2312}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background:var(--bg);color:var(--text)}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:flex;min-height:100vh}nav{width:230px;flex:none;background:var(--card);border-right:1px solid var(--line);
padding:18px 12px;position:sticky;top:0;height:100vh;overflow:auto}nav .brand{font-weight:700;font-size:16px;
padding:4px 10px 14px}nav a{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;
border-radius:8px;color:var(--text)}nav a:hover{background:var(--accent-soft);text-decoration:none}
nav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
main{flex:1;min-width:0;padding:24px 28px;max-width:1200px}h1{font-size:22px;margin:0 0 16px}
h2{font-size:16px;margin:24px 0 10px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--muted);font-size:12px}.card .v{font-size:24px;font-weight:700;margin-top:2px}
.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 0;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--line);
vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}tr:last-child td{border:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--accent-soft);
color:var(--accent)}.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.bad{background:var(--bad-soft);
color:var(--bad)}.badge.warn{background:var(--warn-soft);color:var(--warn)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.tabs a{padding:5px 12px;border-radius:99px;
border:1px solid var(--line);color:var(--text);background:var(--card)}.tabs a.on{background:var(--accent);
color:#fff;border-color:var(--accent)}
button,.btn{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);
color:#fff;cursor:pointer}button.sec{background:transparent;color:var(--text);border-color:var(--line)}
button.bad{background:var(--bad);border-color:var(--bad)}input,textarea{font:inherit;padding:8px 10px;border-radius:8px;
border:1px solid var(--line);background:var(--bg);color:var(--text);width:100%}textarea{min-height:90px;resize:vertical}
form.inline{display:inline}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.flash{padding:10px 14px;border-radius:10px;margin-bottom:14px;background:var(--ok-soft);color:var(--ok)}
.flash.bad{background:var(--bad-soft);color:var(--bad)}.bar{height:8px;border-radius:4px;background:var(--accent);
min-width:2px}.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;
margin-bottom:10px}.msg .t{white-space:pre-wrap;margin:6px 0 10px}.ans{border-left:3px solid var(--ok);
padding-left:10px;color:var(--muted);margin-bottom:8px;white-space:pre-wrap}
.login{max-width:340px;margin:12vh auto;background:var(--card);border:1px solid var(--line);border-radius:14px;
padding:26px}
@media (max-width:760px){.wrap{display:block}nav{width:auto;height:auto;position:static;display:flex;flex-wrap:wrap;
gap:2px;padding:10px}nav .brand{width:100%;padding:4px 10px}main{padding:16px}}
"""

NAV = [
    ("/", "📊 Statistika"), ("/attempts", "🔁 Urinishlar"), ("/users", "👥 Foydalanuvchilar"),
    ("/orders", "🧾 Buyurtmalar"), ("/payments", "💳 Karta kirimlari"), ("/messages?kind=suggestion", "💡 Takliflar"),
    ("/messages?kind=contact", "📞 Murojaatlar"), ("/channels", "📢 Majburiy obuna"), ("/broadcast", "📣 Xabar yuborish"),
    ("/logout", "🚪 Chiqish"),
]


def page(title: str, body: str, active: str = "", counters: dict | None = None, flash: str = "",
         flash_bad: bool = False) -> str:
    counters = counters or {}
    links = []
    for href, label in NAV:
        cnt = counters.get(href)
        badge = f'<span class="badge bad">{cnt}</span>' if cnt else ""
        on = " on" if href == active else ""
        links.append(f'<a class="{on.strip()}" href="{href}">{e(label)}{badge}</a>')
    fl = f'<div class="flash{" bad" if flash_bad else ""}">{e(flash)}</div>' if flash else ""
    return (f'<!doctype html><html lang="uz"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(title)} — Admin</title>'
            f'<style>{CSS}</style></head><body><div class="wrap"><nav><div class="brand">🛠 Admin panel</div>'
            f'{"".join(links)}</nav><main><h1>{e(title)}</h1>{fl}{body}</main></div></body></html>')


def login_page(error: str = "") -> str:
    err = f'<div class="flash bad">{e(error)}</div>' if error else ""
    return (f'<!doctype html><html lang="uz"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kirish — Admin</title>'
            f'<style>{CSS}</style></head><body><form class="login" method="post" action="/login">'
            f'<h1>🛠 Admin panel</h1>{err}<p class="muted">Parolni kiriting</p>'
            f'<input type="password" name="password" autofocus required><p></p>'
            f'<button style="width:100%">Kirish</button></form></body></html>')


def table(headers: list[str], rows: list[list[str]], numeric: set[int] | None = None, empty: str = "Ma'lumot yo'q") -> str:
    """rows — tayyor (escape qilingan) HTML kataklar."""
    numeric = numeric or set()
    if not rows:
        return f'<div class="box"><p class="muted" style="padding:6px 14px">{e(empty)}</p></div>'
    th = "".join(f'<th class="{"n" if i in numeric else ""}">{e(h)}</th>' for i, h in enumerate(headers))
    trs = "".join("<tr>" + "".join(f'<td class="{"n" if i in numeric else ""}">{c}</td>' for i, c in enumerate(r))
                  + "</tr>" for r in rows)
    return f'<div class="box"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'


def tabs(items: list[tuple[str, str]], current: str) -> str:
    return '<div class="tabs">' + "".join(
        f'<a class="{"on" if href == current else ""}" href="{e(href)}">{e(label)}</a>' for href, label in items) + "</div>"


def card(label: str, value) -> str:
    return f'<div class="card"><div class="k">{e(label)}</div><div class="v">{e(str(value))}</div></div>'


def post_button(action: str, label: str, csrf: str, cls: str = "", confirm: str = "") -> str:
    oc = f' onsubmit="return confirm({e(json.dumps(confirm))})"' if confirm else ""
    return (f'<form class="inline" method="post" action="{e(action)}"{oc}><input type="hidden" name="csrf" '
            f'value="{e(csrf)}"><button class="{cls}">{e(label)}</button></form>')
