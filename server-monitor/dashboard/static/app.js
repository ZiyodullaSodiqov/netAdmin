/* NetAdmin Monitor — frontend (tashqi kutubxonasiz) */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const app = $("#app");

const state = {
  servers: [],
  overview: null,
  events: [],
  route: null,
  timer: null,
  range: Number(store("range") || 3600),
  view: store("view") || "grid",
  search: "",
  group: "",
  status: "",
  sort: store("sort") || "name",
  httpTab: "recent",
  authTab: "sessions",
  failCount: 0,
};

// ---------------------------------------------------------------- helpers
function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem("nam." + k);
    localStorage.setItem("nam." + k, v);
  } catch (e) { return null; }
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtBytes(b, digits = 1) {
  if (b == null || isNaN(b)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  b = Number(b);
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? Math.round(b) : b.toFixed(b >= 100 ? 0 : digits)) + " " + u[i];
}
const fmtRate = (b) => (b == null ? "—" : fmtBytes(b) + "/s");
const fmtPct = (v) => (v == null || isNaN(v) ? "—" : (v >= 10 ? Math.round(v) : Number(v).toFixed(1)) + "%");
const fmtNum = (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }).replace(/,/g, " "));

function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return "—";
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} kun ${h} soat`;
  if (h) return `${h} soat ${m} daq`;
  if (m) return `${m} daq`;
  return `${sec} s`;
}
function ago(ts) {
  if (!ts) return "—";
  const s = Date.now() / 1000 - ts;
  if (s < 5) return "hozir";
  if (s < 60) return Math.floor(s) + " s oldin";
  if (s < 3600) return Math.floor(s / 60) + " daq oldin";
  if (s < 86400) return Math.floor(s / 3600) + " soat oldin";
  return Math.floor(s / 86400) + " kun oldin";
}
const pad = (n) => String(n).padStart(2, "0");
function fmtTime(ts, withDate) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const today = new Date();
  if (!withDate && d.toDateString() === today.toDateString()) return t;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${t}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("on"), 2600);
}

// ---------------------------------------------------------------- status icons & badges
const ICONS = {
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7 13H1z" fill="currentColor"/><path d="M8 6v3.6" stroke="#000" stroke-opacity=".75" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".95" fill="#000" fill-opacity=".75"/></svg>',
  crit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1h6l4 4v6l-4 4H5l-4-4V5z" fill="currentColor"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 7.2V11.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="4.8" r="1" fill="#fff"/></svg>',
  mid: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.5 8h7" stroke="#000" stroke-opacity=".75" stroke-width="1.8" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 8h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
const LEVEL = {
  light: { label: "Yengil", icon: "ok" },
  normal: { label: "O'rtacha", icon: "mid" },
  heavy: { label: "Og'ir", icon: "warn" },
  critical: { label: "Kritik", icon: "crit" },
};
function statusBadge(s) {
  if (s.status === "offline") return `<span class="badge offline">${ICONS.crit}Ishlamayapti</span>`;
  if (s.status === "unknown" || !s.summary) return `<span class="badge unknown">${ICONS.off}Tekshirilmoqda</span>`;
  const lv = LEVEL[s.summary.level] || LEVEL.light;
  return `<span class="badge ${s.summary.level}" title="Asosiy sabab: ${esc(s.summary.reason)} ${fmtPct(s.summary.score)}">${ICONS[lv.icon]}${lv.label}</span>`;
}
const barClass = (v) => (v >= 90 ? "crit" : v >= 75 ? "serious" : v >= 50 ? "warn" : "");
function meter(label, v, text) {
  const w = Math.max(0, Math.min(100, v || 0));
  return `<div class="meter"><span class="lbl">${label}</span><div class="bar"><i class="${barClass(v)}" style="width:${w}%"></i></div><span class="val">${text != null ? text : fmtPct(v)}</span></div>`;
}

// ---------------------------------------------------------------- charts
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const tip = $("#tooltip");

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function sparkline(values, max = 100) {
  if (!values || values.length < 2) return '<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"></svg>';
  const n = values.length;
  const pts = values.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(32 - (Math.min(v, max) / max) * 30).toFixed(2)}`);
  return `<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none" aria-label="CPU oxirgi 5 daqiqa">
    <polygon points="0,34 ${pts.join(" ")} 100,34" fill="var(--series-1)" opacity=".10"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="var(--series-1)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

/**
 * Chiziqli grafik: bitta Y o'qi, 2px chiziqlar, crosshair + tooltip.
 * opts: { points, series:[{key,label}], max, fmt, area }
 */
function lineChart(el, opts) {
  const { points, series, fmt = (v) => fmtNum(v, 1) } = opts;
  const W = el.clientWidth || 400, H = el.clientHeight || 190;
  const L = 50, R = 8, T = 8, B = 22;
  const iw = Math.max(10, W - L - R), ih = H - T - B;
  if (!points || points.length < 2) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="nodata" x="${W / 2}" y="${H / 2}" text-anchor="middle">Ma'lumot to'planmoqda…</text></svg>`;
    return;
  }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  let dataMax = 0;
  for (const p of points) for (const s of series) dataMax = Math.max(dataMax, p[s.key] || 0);
  const max = opts.max != null ? Math.max(opts.max, opts.fixed ? 0 : dataMax) : niceMax(dataMax * 1.1);
  const x = (ts) => L + ((ts - t0) / span) * iw;
  const y = (v) => T + ih - (Math.min(v || 0, max) / max) * ih;

  let g = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i, yy = y(v);
    g += `<line class="${i === 0 ? "baseline" : "gridline"}" x1="${L}" x2="${L + iw}" y1="${yy}" y2="${yy}"/>`;
    g += `<text class="tick" x="${L - 6}" y="${yy + 4}" text-anchor="end">${esc(fmt(v, true))}</text>`;
  }
  const xt = Math.max(2, Math.min(6, Math.floor(iw / 90)));
  for (let i = 0; i <= xt; i++) {
    const ts = t0 + (span / xt) * i;
    const d = new Date(ts * 1000);
    const lbl = span > 2 * 86400 ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    g += `<text class="tick" x="${x(ts)}" y="${H - 5}" text-anchor="${i === 0 ? "start" : i === xt ? "end" : "middle"}">${lbl}</text>`;
  }
  // bo'shliqlar (server o'chgan payt) chiziqni uzadi
  const gap = Math.max(span / points.length * 4, 30);
  series.forEach((s, si) => {
    const color = SERIES[si];
    let path = "", area = "", seg = [];
    const flush = () => {
      if (seg.length > 1 && opts.area !== false) area += `<path class="area" fill="${color}" d="M${seg[0][0]},${T + ih} ${seg.map((p) => "L" + p[0] + "," + p[1]).join(" ")} L${seg[seg.length - 1][0]},${T + ih}Z"/>`;
      seg = [];
    };
    points.forEach((p, i) => {
      const px = x(p.ts).toFixed(1), py = y(p[s.key]).toFixed(1);
      const brk = i === 0 || p.ts - points[i - 1].ts > gap;
      if (brk) flush();
      path += (brk ? "M" : "L") + px + "," + py + " ";
      seg.push([px, py]);
    });
    flush();
    g += (series.length === 1 ? area : "") + `<path class="line" stroke="${color}" d="${path}"/>`;
  });
  g += `<g class="hover" style="display:none"><line class="cross" y1="${T}" y2="${T + ih}"/>${series.map((s, i) => `<circle class="dot" r="4" fill="${SERIES[i]}"/>`).join("")}</g>`;
  g += `<rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "grafik")}">${g}</svg>`;

  const svg = el.firstChild, hov = svg.querySelector(".hover"), hit = svg.querySelector(".hit");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    const ts = t0 + ((mx - L) / iw) * span;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].ts - ts) < Math.abs(points[best].ts - ts)) best = i;
    const p = points[best], px = x(p.ts);
    hov.style.display = "";
    hov.querySelector(".cross").setAttribute("x1", px);
    hov.querySelector(".cross").setAttribute("x2", px);
    $$(".dot", hov).forEach((c, i) => { c.setAttribute("cx", px); c.setAttribute("cy", y(p[series[i].key])); });
    tip.innerHTML = `<div class="t">${fmtTime(p.ts, span > 86400)}</div>` +
      series.map((s, i) => `<div class="r"><span><i style="background:${SERIES[i]}"></i>${esc(s.label)}</span><b>${esc(fmt(p[s.key]))}</b></div>`).join("");
    tip.classList.add("on");
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = ev.clientX + 14, top = ev.clientY - th - 10;
    if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
    if (top < 8) top = ev.clientY + 16;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { hov.style.display = "none"; tip.classList.remove("on"); });
}

function legend(series) {
  if (series.length < 2) return "";
  return `<div class="legend">${series.map((s, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(s.label)}</span>`).join("")}</div>`;
}

// ---------------------------------------------------------------- routing
function route() {
  clearTimeout(state.timer);
  tip.classList.remove("on");
  const h = location.hash || "#/";
  const m = h.match(/^#\/server\/(\d+)/);
  state.route = m ? { name: "server", id: Number(m[1]) } : { name: "home" };
  state.detail = null;
  state.history = null;
  app.innerHTML = "";
  refresh();
}
window.addEventListener("hashchange", route);

async function refresh() {
  clearTimeout(state.timer);
  try {
    if (state.route.name === "home") await loadHome();
    else await loadServer(state.route.id);
    state.failCount = 0;
    $("#live-indicator").classList.remove("stale");
  } catch (e) {
    state.failCount++;
    $("#live-indicator").classList.add("stale");
    if (state.failCount === 2) toast("Dashboard serveriga ulanib bo'lmadi: " + e.message);
  }
  const interval = ((state.overview && state.overview.interval) || 5) * 1000;
  state.timer = setTimeout(refresh, Math.max(2000, interval));
}

// ---------------------------------------------------------------- home
async function loadHome() {
  const [servers, overview, events] = await Promise.all([api("/api/servers"), api("/api/overview"), api("/api/events?limit=60")]);
  state.servers = servers;
  state.overview = overview;
  state.events = events;
  updateGroups();
  renderHome();
}

function updateGroups() {
  const groups = [...new Set(state.servers.map((s) => s.group).filter(Boolean))].sort();
  $("#group-list").innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join("");
  return groups;
}

function filtered() {
  const q = state.search.toLowerCase();
  let list = state.servers.filter((s) => {
    if (state.group && s.group !== state.group) return false;
    if (state.status) {
      if (state.status === "offline" && s.status !== "offline") return false;
      if (state.status === "online" && s.status !== "online") return false;
      if (["heavy", "critical"].includes(state.status) && !(s.status === "online" && s.summary && (s.summary.level === "heavy" || s.summary.level === "critical"))) return false;
    }
    if (!q) return true;
    return [s.name, s.host, s.group, s.notes, s.summary && s.summary.hostname].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const key = state.sort;
  const val = (s) => {
    if (key === "name") return s.name.toLowerCase();
    if (key === "status") return s.status === "offline" ? 1000 : s.summary ? s.summary.score : -1;
    return s.summary ? s.summary[key] || 0 : -1;
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (key === "name") return va < vb ? -1 : va > vb ? 1 : 0;
    return vb - va;
  });
  return list;
}

function renderHome() {
  const o = state.overview, c = o.counts;
  if (!state.servers.length) {
    app.innerHTML = `<div class="empty-state">
      <h2>Hali server qo'shilmagan</h2>
      <p>Har bir serverga kichik agent o'rnating (faqat Python 3 kerak), so'ng shu yerga uning IP manzili va tokenini kiriting.
      Dashboard CPU, RAM, disk, yuklama, tarmoq, kirgan foydalanuvchilar va oxirgi API so'rovlarini real vaqtda ko'rsatadi.</p>
      <button class="btn primary" onclick="openServerDialog()">+ Birinchi serverni qo'shish</button>
    </div>`;
    return;
  }
  const heavy = c.heavy + c.critical;
  const tiles = `
    <div class="tiles">
      <div class="tile clickable" data-status=""><div class="k">Jami serverlar</div><div class="v">${c.total}</div><div class="s">${updateGroups().length} ta guruh</div></div>
      <div class="tile clickable" data-status="online"><div class="k"><span class="badge online" style="padding:0;border:0;background:none">${ICONS.ok}</span>Ishlayapti</div><div class="v">${c.online}</div><div class="s">yengil ${c.light} · o'rtacha ${c.normal}</div></div>
      <div class="tile clickable" data-status="offline"><div class="k"><span class="badge offline" style="padding:0;border:0;background:none">${ICONS.crit}</span>Ishlamayapti</div><div class="v">${c.offline}</div><div class="s">${c.offline ? "e'tibor bering!" : "hammasi aloqada"}</div></div>
      <div class="tile clickable" data-status="heavy"><div class="k"><span class="badge heavy" style="padding:0;border:0;background:none">${ICONS.warn}</span>Og'ir / Kritik</div><div class="v">${heavy}</div><div class="s">og'ir ${c.heavy} · kritik ${c.critical}</div></div>
      <div class="tile"><div class="k">O'rtacha CPU</div><div class="v">${fmtPct(o.avg_cpu)}</div><div class="s">ishlayotgan serverlar bo'yicha</div></div>
      <div class="tile"><div class="k">O'rtacha RAM</div><div class="v">${fmtPct(o.avg_mem)}</div><div class="s">ishlayotgan serverlar bo'yicha</div></div>
      <div class="tile"><div class="k">Tarmoq trafigi</div><div class="v">${fmtRate(o.rx + o.tx)}</div><div class="s">↓ ${fmtRate(o.rx)} · ↑ ${fmtRate(o.tx)}</div></div>
      <div class="tile"><div class="k">HTTP so'rovlar</div><div class="v">${fmtNum(o.rpm, 1)}<small class="muted" style="font-size:13px"> /daq</small></div><div class="s">oxirgi 5 daqiqa o'rtachasi</div></div>
      <div class="tile"><div class="k">Hozir kirganlar</div><div class="v">${o.users}</div><div class="s">SSH xato urinish (24s): ${fmtNum(o.failed_24h)}</div></div>
    </div>`;
  const groups = updateGroups();
  const toolbar = `
    <div class="toolbar">
      <input class="search" type="search" placeholder="Qidirish: nom, IP, guruh…" value="${esc(state.search)}" id="search">
      ${groups.length ? `<select id="group-filter"><option value="">Barcha guruhlar</option>${groups.map((g) => `<option ${g === state.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>` : ""}
      <select id="status-filter">
        ${[["", "Barcha holatlar"], ["online", "Ishlayapti"], ["offline", "Ishlamayapti"], ["heavy", "Og'ir / Kritik"]].map(([v, l]) => `<option value="${v}" ${v === state.status ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <select id="sort">
        ${[["name", "Nomi bo'yicha"], ["status", "Yuklama bo'yicha"], ["cpu", "CPU bo'yicha"], ["mem", "RAM bo'yicha"], ["disk", "Disk bo'yicha"], ["rpm", "So'rovlar bo'yicha"]].map(([v, l]) => `<option value="${v}" ${v === state.sort ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Ko'rinish">
        <button data-view="grid" class="${state.view === "grid" ? "on" : ""}">Kartalar</button>
        <button data-view="table" class="${state.view === "table" ? "on" : ""}">Jadval</button>
      </div>
    </div>`;
  const list = filtered();
  const servers = list.length ? (state.view === "grid" ? renderGrid(list) : renderTable(list)) : `<div class="panel empty">Filtr bo'yicha server topilmadi.</div>`;
  const events = `
    <div class="section-title">Oxirgi hodisalar <span class="muted">kirishlar, o'chib-yonishlar, yuklama ogohlantirishlari</span></div>
    <div class="panel">${renderEvents(state.events, true)}</div>`;

  const focused = document.activeElement && document.activeElement.id === "search";
  const caret = focused ? document.activeElement.selectionStart : null;
  app.innerHTML = tiles + toolbar + servers + events;
  bindHome();
  if (focused) { const s = $("#search"); s.focus(); s.setSelectionRange(caret, caret); }
}

function renderGrid(list) {
  return `<div class="grid">${list.map((s) => {
    const m = s.summary;
    const body = s.status === "offline" || !m
      ? `<div class="err">${esc(s.error || "Ma'lumot kutilmoqda…")}</div><div class="card-foot"><span>oxirgi aloqa: ${ago(s.last_ok)}</span></div>`
      : `<div class="card-meters">
          ${meter("CPU", m.cpu)}
          ${meter("RAM", m.mem)}
          ${meter("Disk", m.disk)}
          ${meter("Load", Math.min(100, m.load_pc * 80), Number(m.load1).toFixed(2))}
        </div>
        ${sparkline(s.spark)}
        <div class="card-foot">
          <span title="Ishlash vaqti">⏱ ${fmtDuration(m.uptime)}</span>
          <span title="Tarmoq">⇅ ${fmtRate(m.rx + m.tx)}</span>
          <span title="HTTP so'rov / daqiqa">${fmtNum(m.rpm, 1)} so'rov/daq</span>
          <span title="Hozir kirgan foydalanuvchilar">👤 ${m.users}</span>
        </div>`;
    return `<a class="card ${s.status}" href="#/server/${s.id}">
      <div class="card-head">
        <div style="min-width:0">
          <div class="card-name">${esc(s.name)}</div>
          <div class="card-host">${esc(s.host)}${s.group ? " · " + esc(s.group) : ""}${m && m.cores ? " · " + m.cores + " yadro" : ""}</div>
        </div>
        ${statusBadge(s)}
      </div>${body}</a>`;
  }).join("")}</div>`;
}

function renderTable(list) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Server</th><th>IP</th><th>Guruh</th><th>Holat</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Disk</th><th class="num">Load</th><th class="num">Tarmoq</th><th class="num">So'rov/daq</th><th class="num">Kirganlar</th><th class="num">Uptime</th><th class="num">Ping</th></tr></thead>
    <tbody>${list.map((s) => {
      const m = s.summary, on = s.status === "online" && m;
      return `<tr class="link" data-id="${s.id}">
        <td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.host)}:${s.port}</td><td>${esc(s.group)}</td><td>${statusBadge(s)}</td>
        <td class="num">${on ? fmtPct(m.cpu) : "—"}</td><td class="num">${on ? fmtPct(m.mem) : "—"}</td><td class="num">${on ? fmtPct(m.disk) : "—"}</td>
        <td class="num">${on ? Number(m.load1).toFixed(2) : "—"}</td><td class="num">${on ? fmtRate(m.rx + m.tx) : "—"}</td>
        <td class="num">${on ? fmtNum(m.rpm, 1) : "—"}</td><td class="num">${on ? m.users : "—"}</td>
        <td class="num">${on ? fmtDuration(m.uptime) : "—"}</td><td class="num">${s.latency != null ? Math.round(s.latency) + " ms" : "—"}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderEvents(events, showServer) {
  if (!events.length) return `<div class="empty">Hozircha hodisa yo'q.</div>`;
  return `<ul class="events">${events.map((e) => `
    <li class="${esc(e.level)}">${ICONS[e.level] || ICONS.info}
      <span>${esc(e.message)}${showServer && e.server_id ? ` <a href="#/server/${e.server_id}" class="muted">ochish</a>` : ""}</span>
      <time title="${fmtTime(e.ts, true)}">${fmtTime(e.ts)}</time></li>`).join("")}</ul>`;
}

function bindHome() {
  const s = $("#search");
  if (s) s.addEventListener("input", () => { state.search = s.value; renderHome(); });
  const g = $("#group-filter");
  if (g) g.addEventListener("change", () => { state.group = g.value; renderHome(); });
  const st = $("#status-filter");
  if (st) st.addEventListener("change", () => { state.status = st.value; renderHome(); });
  const so = $("#sort");
  if (so) so.addEventListener("change", () => { state.sort = so.value; store("sort", so.value); renderHome(); });
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; store("view", state.view); renderHome(); }));
  $$(".tile[data-status]").forEach((t) => t.addEventListener("click", () => { state.status = t.dataset.status; renderHome(); }));
  $$("tr.link").forEach((tr) => tr.addEventListener("click", () => { location.hash = "#/server/" + tr.dataset.id; }));
}

// ---------------------------------------------------------------- server detail
const RANGES = [[900, "15 daq"], [3600, "1 soat"], [6 * 3600, "6 soat"], [86400, "24 soat"], [7 * 86400, "7 kun"], [30 * 86400, "30 kun"]];

async function loadServer(id) {
  const needHistory = !state.history || state.range <= 6 * 3600 || Date.now() - state.historyAt > 60000;
  const [detail, history, events] = await Promise.all([
    api("/api/servers/" + id),
    needHistory ? api(`/api/servers/${id}/history?range=${state.range}`) : Promise.resolve(state.history),
    api(`/api/events?server=${id}&limit=40`),
  ]);
  if (needHistory) state.historyAt = Date.now();
  state.detail = detail;
  state.history = history;
  state.serverEvents = events;
  if (!state.overview) state.overview = await api("/api/overview");
  renderServer();
}

function panel(title, body, cls = "", sub = "") {
  return `<section class="panel ${cls}"><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ""}${body}</section>`;
}
function table(headers, rows, empty = "Ma'lumot yo'q") {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap scroll"><table><thead><tr>${headers.map((h) => `<th class="${h.endsWith("#") ? "num" : ""}">${h.replace(/#$/, "")}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function hbars(items, labelKey, valKey) {
  if (!items || !items.length) return `<div class="empty">Ma'lumot yo'q</div>`;
  const max = Math.max(...items.map((i) => i[valKey]));
  return items.map((i) => `<div class="hbar"><span class="name" title="${esc(i[labelKey])}">${esc(i[labelKey])}</span><div class="bar"><i style="width:${(i[valKey] / max) * 100}%"></i></div><span class="val">${fmtNum(i[valKey])}</span></div>`).join("");
}
const errOr = (v) => v && typeof v === "object" && v.error;

function renderServer() {
  const s = state.detail, snap = s.snapshot, m = s.summary;
  const scrollY = window.scrollY;
  const h = (snap && snap.host) || {};
  const head = `
    <a class="back" href="#/">← Barcha serverlar</a>
    <div class="detail-head">
      <div>
        <h1>${esc(s.name)} ${statusBadge(s)}</h1>
        <div class="meta">
          <span>IP: <b class="mono">${esc(s.host)}:${s.port}</b></span>
          ${h.hostname ? `<span>Hostname: <b>${esc(h.hostname)}</b></span>` : ""}
          ${h.os ? `<span>OS: <b>${esc(h.os)}</b></span>` : ""}
          ${h.cores ? `<span>CPU: <b>${h.cores} yadro</b> ${esc(h.cpu_model || "")}</span>` : ""}
          ${h.uptime ? `<span>Ishlash vaqti: <b>${fmtDuration(h.uptime)}</b></span>` : ""}
          ${s.group ? `<span>Guruh: <b>${esc(s.group)}</b></span>` : ""}
          <span>Ping: <b>${s.latency != null ? Math.round(s.latency) + " ms" : "—"}</b></span>
          <span>Yangilandi: <b>${ago(s.last_ok)}</b></span>
        </div>
        ${s.notes ? `<div class="muted" style="margin-top:4px">${esc(s.notes)}</div>` : ""}
      </div>
      <div class="row">
        <button class="btn ghost" id="poll-btn">Yangilash</button>
        <button class="btn ghost" id="edit-btn">Tahrirlash</button>
        <button class="btn ghost danger" id="del-btn">O'chirish</button>
      </div>
    </div>
    ${s.status === "offline" ? `<div class="alert"><b>Server javob bermayapti.</b> ${esc(s.error)} — oxirgi aloqa: ${ago(s.last_ok)}. Quyida oxirgi ma'lum holat ko'rsatilgan.</div>` : ""}`;

  if (!snap || !m) {
    app.innerHTML = head + `<div class="panel empty">${s.error ? esc(s.error) : "Agentdan birinchi ma'lumot kutilmoqda…"}<br><br>
      Tekshiring: agent ishlayaptimi (<code>systemctl status netadmin-agent</code>), port ${s.port} firewallda ochiqmi, token to'g'rimi.</div>`;
    bindServer();
    return;
  }

  const mem = snap.memory || {};
  const lv = LEVEL[m.level] || LEVEL.light;
  const tiles = `
    <div class="tiles">
      <div class="tile"><div class="k">Yuklama holati</div><div class="v">${lv.label}</div><div class="s">asosiy omil: ${esc(m.reason)} ${fmtPct(m.score)}</div></div>
      <div class="tile"><div class="k">CPU</div><div class="v">${fmtPct(m.cpu)}</div><div class="s">iowait ${fmtPct(m.iowait)} · steal ${fmtPct(snap.cpu.steal)}</div></div>
      <div class="tile"><div class="k">RAM</div><div class="v">${fmtPct(m.mem)}</div><div class="s">${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}</div></div>
      <div class="tile"><div class="k">Disk (eng to'la)</div><div class="v">${fmtPct(m.disk)}</div><div class="s">${(snap.disks || []).length} ta bo'lim</div></div>
      <div class="tile"><div class="k">Load average</div><div class="v">${Number(snap.load["1"]).toFixed(2)}</div><div class="s">5m ${Number(snap.load["5"]).toFixed(2)} · 15m ${Number(snap.load["15"]).toFixed(2)} · ${snap.load.per_core}/yadro</div></div>
      <div class="tile"><div class="k">Tarmoq</div><div class="v">${fmtRate(m.rx + m.tx)}</div><div class="s">↓ ${fmtRate(m.rx)} · ↑ ${fmtRate(m.tx)}</div></div>
      <div class="tile"><div class="k">Swap</div><div class="v">${fmtPct(mem.swap_percent)}</div><div class="s">${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)}</div></div>
      <div class="tile"><div class="k">Jarayonlar</div><div class="v">${fmtNum(snap.processes.count)}</div><div class="s">${fmtNum(snap.processes.threads)} thread · TCP ${fmtNum(m.tcp)}</div></div>
      <div class="tile"><div class="k">HTTP so'rov</div><div class="v">${fmtNum(m.rpm, 1)}<small class="muted" style="font-size:13px"> /daq</small></div><div class="s">${snap.http && snap.http.requests_1h != null ? fmtNum(snap.http.requests_1h) + " ta oxirgi 1 soatda" : "access log topilmadi"}</div></div>
      ${m.temp ? `<div class="tile"><div class="k">Harorat (maks)</div><div class="v">${Math.round(m.temp)}°C</div><div class="s">${(snap.temps || []).length} ta datchik</div></div>` : ""}
    </div>`;

  const charts = [
    { id: "c-cpu", title: "CPU yuklamasi", series: [{ key: "cpu", label: "CPU" }, { key: "iowait", label: "IO wait" }], max: 100, fixed: true, fmt: (v) => fmtPct(v) },
    { id: "c-mem", title: "RAM va Swap", series: [{ key: "mem", label: "RAM" }, { key: "swap", label: "Swap" }], max: 100, fixed: true, fmt: (v) => fmtPct(v) },
    { id: "c-load", title: "Load average (1 daq)", series: [{ key: "load1", label: "Load" }], max: Math.max(1, h.cores || 1), fmt: (v) => Number(v || 0).toFixed(2) },
    { id: "c-net", title: "Tarmoq trafigi", series: [{ key: "rx", label: "Kiruvchi ↓" }, { key: "tx", label: "Chiquvchi ↑" }], fmt: (v) => fmtRate(v) },
    { id: "c-disk", title: "Disk o'qish/yozish", series: [{ key: "dr", label: "O'qish" }, { key: "dw", label: "Yozish" }], fmt: (v) => fmtRate(v) },
    { id: "c-rpm", title: "HTTP so'rovlar / daqiqa", series: [{ key: "rpm", label: "So'rov/daq" }], fmt: (v) => fmtNum(v, 1) },
    { id: "c-tcp", title: "TCP ulanishlar (ESTABLISHED)", series: [{ key: "tcp", label: "Ulanishlar" }], fmt: (v) => fmtNum(v) },
    { id: "c-dfull", title: "Disk to'lishi (eng to'la bo'lim)", series: [{ key: "disk", label: "Disk" }], max: 100, fixed: true, fmt: (v) => fmtPct(v) },
  ];
  const rangeSel = `<div class="seg" role="group" aria-label="Vaqt oralig'i">${RANGES.map(([v, l]) => `<button data-range="${v}" class="${v === state.range ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const chartPanels = `
    <div class="section-title">Grafiklar ${rangeSel}</div>
    <div class="panels">${charts.map((c) => panel(c.title, legend(c.series) + `<div class="chart" id="${c.id}"></div>`)).join("")}</div>`;

  // CPU yadrolari + disklar + tarmoq interfeyslari
  const cores = (snap.cpu.cores || []).map((v, i) => meter("#" + i, v)).join("");
  const disks = table(["Bo'lim", "Qurilma", "Tur", "Hajm#", "Band#", "Bo'sh#", "To'lishi", "Inode#"],
    (snap.disks || []).map((d) => `<tr><td class="mono">${esc(d.mount)}</td><td class="mono">${esc(d.device)}</td><td>${esc(d.fstype)}</td>
      <td class="num">${fmtBytes(d.total)}</td><td class="num">${fmtBytes(d.used)}</td><td class="num">${fmtBytes(d.free)}</td>
      <td style="min-width:130px">${meter("", d.percent).replace('<span class="lbl"></span>', "")}</td><td class="num">${fmtPct(d.inodes_percent)}</td></tr>`));
  const dio = Object.entries(snap.disk_io || {});
  const diskio = table(["Disk", "O'qish#", "Yozish#", "IOPS o'q/yoz#", "Bandlik#"],
    dio.map(([n, d]) => `<tr><td class="mono">${esc(n)}</td><td class="num">${fmtRate(d.read)}</td><td class="num">${fmtRate(d.write)}</td>
      <td class="num">${fmtNum(d.read_iops)} / ${fmtNum(d.write_iops)}</td><td class="num">${fmtPct(d.util)}</td></tr>`));
  const nets = table(["Interfeys", "Kiruvchi#", "Chiquvchi#", "Paket/s#", "Jami ↓/↑#", "Xato/drop#"],
    Object.entries(snap.net || {}).map(([n, d]) => `<tr><td class="mono">${esc(n)}</td><td class="num">${fmtRate(d.rx)}</td><td class="num">${fmtRate(d.tx)}</td>
      <td class="num">${fmtNum(d.rx_pkt + d.tx_pkt)}</td><td class="num">${fmtBytes(d.rx_total)} / ${fmtBytes(d.tx_total)}</td><td class="num">${fmtNum(d.errors)} / ${fmtNum(d.drops)}</td></tr>`));

  const hw = `
    <div class="section-title">Resurslar</div>
    <div class="panels">
      ${panel("CPU yadrolari", `<div class="cores">${cores}</div>`, "", `${(snap.cpu.cores || []).length} ta yadro · user ${fmtPct(snap.cpu.user)} · system ${fmtPct(snap.cpu.system)}`)}
      ${panel("Xotira", `<dl class="kv">
          <dt>Jami</dt><dd>${fmtBytes(mem.total)}</dd><dt>Ishlatilgan</dt><dd>${fmtBytes(mem.used)} (${fmtPct(mem.percent)})</dd>
          <dt>Mavjud</dt><dd>${fmtBytes(mem.available)}</dd><dt>Kesh / bufer</dt><dd>${fmtBytes(mem.cached)} / ${fmtBytes(mem.buffers)}</dd>
          <dt>Swap</dt><dd>${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)}</dd></dl>`)}
      ${panel("Disklar", disks, "wide")}
      ${panel("Disk I/O", diskio)}
      ${panel("Tarmoq interfeyslari", nets)}
    </div>`;

  // Jarayonlar
  const procs = (snap.processes.top || []).slice().sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  const procPanel = panel("Eng ko'p resurs ishlatayotgan jarayonlar", table(["PID#", "Foydalanuvchi", "Nomi", "CPU#", "RAM#", "RAM %#", "Buyruq"],
    procs.map((p) => `<tr><td class="num">${p.pid}</td><td>${esc(p.user)}</td><td><b>${esc(p.name)}</b></td><td class="num">${fmtPct(p.cpu)}</td>
      <td class="num">${fmtBytes(p.mem)}</td><td class="num">${fmtPct(p.mem_pct)}</td><td class="mono wrap muted">${esc(p.cmd)}</td></tr>`)), "wide");

  // Kim kirdi
  const users = Array.isArray(snap.users) ? snap.users : [];
  const logins = Array.isArray(snap.logins) ? snap.logins : [];
  const auth = errOr(snap.auth) ? {} : snap.auth || {};
  const authTabs = [["sessions", `Kirish tarixi (${logins.length})`], ["accepted", `SSH muvaffaqiyatli (${(auth.accepted || []).length})`], ["failed", `Xato urinishlar (${(auth.failed || []).length})`], ["sudo", `sudo buyruqlar (${(auth.sudo || []).length})`]];
  let authBody = "";
  if (state.authTab === "sessions") {
    authBody = table(["Foydalanuvchi", "Qayerdan", "Terminal", "Kirdi", "Chiqdi", "Davomiyligi"],
      logins.map((l) => l.raw ? `<tr><td colspan="6" class="mono">${esc(l.raw)}</td></tr>` : `<tr><td><b>${esc(l.user)}</b></td><td class="mono">${esc(l.from)}</td><td class="mono">${esc(l.tty)}</td>
        <td class="num">${fmtTime(l.login, true)}</td><td class="num">${l.active ? '<span class="badge online">' + ICONS.ok + "hozir ichkarida</span>" : fmtTime(l.logout, true)}</td>
        <td class="num">${l.login ? fmtDuration((l.logout || Date.now() / 1000) - l.login) : "—"}</td></tr>`), "wtmp tarixi topilmadi");
  } else if (state.authTab === "accepted") {
    authBody = table(["Vaqt", "Foydalanuvchi", "IP manzil", "Usul"], (auth.accepted || []).map((a) => `<tr><td class="num">${fmtTime(a.ts, true)}</td><td><b>${esc(a.user)}</b></td><td class="mono">${esc(a.ip)}</td><td>${esc(a.method)}</td></tr>`), "SSH kirishlar logda topilmadi");
  } else if (state.authTab === "failed") {
    authBody = table(["Vaqt", "Foydalanuvchi", "IP manzil"], (auth.failed || []).map((a) => `<tr><td class="num">${fmtTime(a.ts, true)}</td><td>${esc(a.user)}</td><td class="mono">${esc(a.ip)}</td></tr>`), "Xato urinishlar yo'q 👍");
  } else {
    authBody = table(["Vaqt", "Foydalanuvchi", "Buyruq"], (auth.sudo || []).map((a) => `<tr><td class="num">${fmtTime(a.ts, true)}</td><td><b>${esc(a.user)}</b></td><td class="mono wrap">${esc(a.command)}</td></tr>`), "sudo buyruqlari topilmadi");
  }
  const who = `
    <div class="section-title">Kim kirdi <span class="muted">SSH, konsol, sudo</span></div>
    <div class="panels">
      ${panel(`Hozir ichkarida <span class="muted">${users.length} ta seans</span>`, table(["Foydalanuvchi", "Qayerdan", "Terminal", "Qachondan"],
        users.map((u) => `<tr><td><b>${esc(u.user)}</b></td><td class="mono">${esc(u.from)}</td><td class="mono">${esc(u.tty)}</td><td class="num">${u.since ? fmtTime(u.since, true) + " (" + ago(u.since) + ")" : "—"}</td></tr>`), "Hozir hech kim kirmagan"))}
      ${panel(`Hujum qilayotgan IP lar <span class="muted">24 soatda ${fmtNum(auth.failed_24h || 0)} ta xato urinish</span>`, hbars(auth.top_failed_ips, "ip", "count"))}
      ${panel(`<span>Kirishlar</span><span class="seg" role="tablist">${authTabs.map(([k, l]) => `<button data-authtab="${k}" class="${state.authTab === k ? "on" : ""}">${l}</button>`).join("")}</span>`, authBody, "wide")}
    </div>`;

  // HTTP / API
  const http = errOr(snap.http) ? null : snap.http;
  let httpSection = "";
  if (!http || !http.files || !http.files.length) {
    httpSection = `<div class="section-title">Oxirgi API so'rovlar</div><div class="panel empty">Access log topilmadi. Agentni <code>--access-log "/var/log/nginx/*access.log"</code> bilan sozlang
      (standart: nginx, apache, caddy loglari qidiriladi).</div>`;
  } else {
    const httpTabs = [["recent", `Oxirgi so'rovlar (${http.recent.length})`], ["endpoints", "Eng ko'p chaqirilgan API"], ["errors", "5xx xatolar"], ["ips", "Mijoz IP lari"]];
    let hb = "";
    if (state.httpTab === "recent") {
      hb = table(["Vaqt", "IP", "Metod", "Manzil (URL)", "Status#", "Hajm#", "Vaqt (ms)#", "User-Agent"],
        http.recent.map((r) => `<tr><td class="num">${fmtTime(r.ts)}</td><td class="mono">${esc(r.ip)}</td><td class="method">${esc(r.method)}</td>
          <td class="mono wrap">${esc(r.path)}</td><td class="num"><span class="st s${Math.floor(r.status / 100)}">${r.status}</span></td>
          <td class="num">${fmtBytes(r.bytes)}</td><td class="num">${r.rt != null ? Math.round(r.rt * 1000) : "—"}</td><td class="muted wrap" style="max-width:260px">${esc(r.ua)}</td></tr>`));
    } else if (state.httpTab === "endpoints") hb = hbars(http.top_endpoints, "endpoint", "count");
    else if (state.httpTab === "errors") hb = hbars(http.top_errors, "endpoint", "count");
    else hb = hbars(http.top_ips, "ip", "count");
    const st = http.status || {};
    const total = Object.values(st).reduce((a, b) => a + b, 0) || 1;
    httpSection = `
      <div class="section-title">Oxirgi API so'rovlar <span class="muted">${esc(http.files.join(", "))}</span></div>
      <div class="tiles">
        <div class="tile"><div class="k">So'rov / daqiqa</div><div class="v">${fmtNum(http.rpm, 1)}</div><div class="s">oxirgi 5 daqiqa</div></div>
        <div class="tile"><div class="k">Oxirgi 1 soat</div><div class="v">${fmtNum(http.requests_1h)}</div><div class="s">ta so'rov</div></div>
        <div class="tile"><div class="k">Muvaffaqiyatli (2xx/3xx)</div><div class="v">${fmtPct((((st["2xx"] || 0) + (st["3xx"] || 0)) / total) * 100)}</div><div class="s">${fmtNum((st["2xx"] || 0) + (st["3xx"] || 0))} ta</div></div>
        <div class="tile"><div class="k">Mijoz xatosi (4xx)</div><div class="v">${fmtNum(st["4xx"] || 0)}</div><div class="s">${fmtPct(((st["4xx"] || 0) / total) * 100)}</div></div>
        <div class="tile"><div class="k">Server xatosi (5xx)</div><div class="v">${fmtNum(st["5xx"] || 0)}</div><div class="s">${fmtPct(((st["5xx"] || 0) / total) * 100)}</div></div>
        <div class="tile"><div class="k">Javob vaqti p95</div><div class="v">${http.p95_ms != null ? fmtNum(http.p95_ms) + " ms" : "—"}</div><div class="s">${http.p95_ms != null ? "oxirgi 5 daqiqa" : "logda $request_time yo'q"}</div></div>
      </div>
      <div class="panels">${panel(`<span>HTTP</span><span class="seg" role="tablist">${httpTabs.map(([k, l]) => `<button data-httptab="${k}" class="${state.httpTab === k ? "on" : ""}">${l}</button>`).join("")}</span>`, hb, "wide")}</div>`;
  }

  // Portlar, servislar, hodisalar
  const sock = errOr(snap.sockets) ? {} : snap.sockets || {};
  const svc = errOr(snap.services) ? {} : snap.services || {};
  const tcpStates = Object.entries(sock.tcp_states || {}).sort((a, b) => b[1] - a[1]);
  const net2 = `
    <div class="section-title">Portlar, ulanishlar va servislar</div>
    <div class="panels">
      ${panel(`Ochiq (tinglayotgan) portlar <span class="muted">${(sock.listening || []).length} ta</span>`, table(["Protokol", "Port#", "Manzil", "Jarayon"],
        (sock.listening || []).map((p) => `<tr><td>${p.proto.toUpperCase()}</td><td class="num"><b>${p.port}</b></td><td class="mono">${esc(p.addr)}</td><td>${esc(p.process || "—")}${p.pid ? ' <span class="muted">(' + p.pid + ")</span>" : ""}</td></tr>`)))}
      ${panel("Eng ko'p ulangan IP lar", hbars(sock.top_remote, "ip", "count"), "", `TCP holatlari: ${tcpStates.map(([k, v]) => `${esc(k)} ${v}`).join(" · ") || "—"}`)}
      ${panel(`Systemd servislar <span class="muted">${svc.running || 0} ta ishlayapti</span>`, svc.failed && svc.failed.length
        ? `<div class="sub">Ishdan chiqqan servislar:</div><div class="chips">${svc.failed.map((f) => `<span class="chip" style="color:var(--critical-text)">${esc(f)}</span>`).join("")}</div>`
        : `<div class="empty">${ICONS.ok.replace("<svg", '<svg style="width:14px;height:14px;color:var(--good);vertical-align:-2px"')} Ishdan chiqqan servis yo'q</div>`)}
      ${panel("Shu server hodisalari", renderEvents(state.serverEvents || [], false))}
    </div>`;

  app.innerHTML = head + tiles + chartPanels + hw + procPanel.replace("<section", '<div class="section-title">Jarayonlar</div><section') + who + httpSection + net2;
  const pts = (state.history && state.history.points) || [];
  charts.forEach((c) => lineChart($("#" + c.id), Object.assign({ points: pts }, c)));
  bindServer();
  window.scrollTo(0, scrollY);
}

function bindServer() {
  const s = state.detail;
  $("#poll-btn") && $("#poll-btn").addEventListener("click", async () => { await api(`/api/servers/${s.id}/poll`, { method: "POST" }); setTimeout(refresh, 800); toast("So'rov yuborildi"); });
  $("#edit-btn") && $("#edit-btn").addEventListener("click", () => openServerDialog(s));
  $("#del-btn") && $("#del-btn").addEventListener("click", async () => {
    if (!confirm(`"${s.name}" serverini va uning butun tarixini o'chirasizmi?`)) return;
    await api("/api/servers/" + s.id, { method: "DELETE" });
    toast("Server o'chirildi");
    location.hash = "#/";
  });
  $$("[data-range]").forEach((b) => b.addEventListener("click", () => { state.range = Number(b.dataset.range); store("range", state.range); state.history = null; refresh(); }));
  $$("[data-authtab]").forEach((b) => b.addEventListener("click", () => { state.authTab = b.dataset.authtab; renderServer(); }));
  $$("[data-httptab]").forEach((b) => b.addEventListener("click", () => { state.httpTab = b.dataset.httptab; renderServer(); }));
}

let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.route && state.route.name === "server" && state.detail) renderServer(); }, 150);
});

// ---------------------------------------------------------------- dialogs
const dlg = $("#server-dialog"), form = $("#server-form");
let editing = null;

function installCmd() {
  const f = form.elements;
  const token = f.token.value.trim() || "<TOKEN>";
  const host = f.host.value.trim() || "<SERVER_IP>";
  const port = f.port.value || 9800;
  const local = location.hostname;
  return `# 1) agent fayllarini serverga nusxalash (netadmin papkasidan)
scp server-monitor/agent/netadmin_agent.py server-monitor/agent/install.sh root@${host}:/tmp/

# 2) serverda o'rnatish
ssh root@${host} "bash /tmp/install.sh --token ${token} --port ${port}"

# (ixtiyoriy) faqat dashboard IP siga ruxsat:  --allow <dashboard IP>
# fayllarni brauzerdan yuklab olish: http://${local}:${location.port || 80}/download/install.sh`;
}
function updateInstall() { $("#install-cmd").textContent = installCmd(); }

window.openServerDialog = function (srv) {
  editing = srv || null;
  form.reset();
  $("#server-error").textContent = "";
  $("#server-dialog-title").textContent = srv ? "Serverni tahrirlash" : "Server qo'shish";
  const f = form.elements;
  if (srv) {
    f.name.value = srv.name; f.host.value = srv.host; f.port.value = srv.port; f.group.value = srv.group || ""; f.notes.value = srv.notes || "";
    f.token.placeholder = "o'zgartirmaslik uchun bo'sh qoldiring (" + (srv.token_hint || "") + ")";
    $(".install").open = false;
  } else {
    f.token.placeholder = "agent tokeni";
    $(".install").open = true;
    api("/api/token").then((d) => { if (!f.token.value) { f.token.value = d.token; updateInstall(); } });
  }
  updateInstall();
  dlg.showModal();
  setTimeout(() => f[srv ? "name" : "host"].focus(), 30);
};

form.addEventListener("input", updateInstall);
$("#gen-token").addEventListener("click", async () => { form.elements.token.value = (await api("/api/token")).token; updateInstall(); });
$("#copy-install").addEventListener("click", () => {
  navigator.clipboard && navigator.clipboard.writeText(installCmd()).then(() => toast("Nusxa olindi"), () => toast("Nusxa olib bo'lmadi"));
});
$("#server-cancel").addEventListener("click", () => dlg.close());
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = form.elements;
  const body = { name: f.name.value, host: f.host.value, port: Number(f.port.value) || 9800, token: f.token.value, group: f.group.value, notes: f.notes.value };
  try {
    if (editing) await api("/api/servers/" + editing.id, { method: "PUT", body });
    else {
      const r = await api("/api/servers", { method: "POST", body });
      if (state.route.name === "home") setTimeout(refresh, 1200);
      toast("Server qo'shildi — ulanish tekshirilmoqda…");
      dlg.close();
      location.hash = "#/server/" + r.id;
      return;
    }
    dlg.close();
    toast("Saqlandi");
    setTimeout(refresh, 800);
  } catch (e) {
    $("#server-error").textContent = e.message;
  }
});

const bulk = $("#bulk-dialog"), bulkForm = $("#bulk-form");
$("#bulk-btn").addEventListener("click", () => { bulkForm.reset(); $("#bulk-error").textContent = ""; bulk.showModal(); });
$("#bulk-cancel").addEventListener("click", () => bulk.close());
bulkForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = bulkForm.elements;
  try {
    const r = await api("/api/servers/bulk", { method: "POST", body: { text: f.text.value, token: f.token.value, group: f.group.value } });
    if (r.errors.length) $("#bulk-error").textContent = r.errors.join("; ");
    else bulk.close();
    toast(`${r.added} ta server qo'shildi`);
    setTimeout(refresh, 1200);
  } catch (e) { $("#bulk-error").textContent = e.message; }
});
$("#add-btn").addEventListener("click", () => openServerDialog());

// ---------------------------------------------------------------- theme
function applyTheme(t) {
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}
applyTheme(store("theme"));
$("#theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  store("theme", next);
  applyTheme(next);
  if (state.route && state.route.name === "server" && state.detail) renderServer();
});

route();
