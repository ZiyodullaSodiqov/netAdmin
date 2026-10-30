/* NetAdmin Monitor — qo'shimcha sahifalar: saytlar, DigitalOcean, sozlamalar, loglar, SSH orqali o'rnatish */
"use strict";

function forecastText(f) {
  if (!f || f.days == null) return "";
  if (f.days > 365) return "";
  return `shu tezlikda ~${f.days < 2 ? f.days.toFixed(1) : Math.round(f.days)} kunda to'ladi`;
}
const fmtMs = (v) => (v == null || isNaN(v) ? "—" : Math.round(v) + " ms");
const fmtUsd = (v) => (v == null || isNaN(v) ? "—" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const fmtMb = (mb) => (mb >= 1024 ? +(mb / 1024).toFixed(1) + " GB" : mb + " MB");
const daysLeft = (ts) => (ts ? Math.floor((ts - Date.now() / 1000) / 86400) : null);

function siteBadge(s) {
  if (s.status === "up") return `<span class="badge light">${ICONS.ok}Ishlayapti</span>`;
  if (s.status === "down") return `<span class="badge critical">${ICONS.crit}Ishlamayapti</span>`;
  return `<span class="badge unknown">${ICONS.off}Tekshirilmoqda</span>`;
}
function sslCell(s) {
  if (!/^https:/i.test(s.url)) return '<span class="muted">http</span>';
  if (s.ssl_valid === false) return `<span class="badge critical" title="${esc(s.ssl_error)}">${ICONS.crit}Xato</span>`;
  const d = daysLeft(s.ssl_expires);
  if (d == null) return '<span class="muted">…</span>';
  const cls = d <= 3 ? "critical" : d <= 14 ? "heavy" : "light";
  const icon = d <= 3 ? "crit" : d <= 14 ? "warn" : "ok";
  return `<span class="badge ${cls}" title="${esc(s.ssl_issuer || "")}">${ICONS[icon]}${d} kun</span>`;
}
function msSpark(vals, oks) {
  if (!vals || vals.length < 2) return '<svg class="mini-spark" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>';
  const max = Math.max(50, ...vals) * 1.1, n = vals.length;
  const pts = vals.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(22 - (v / max) * 20).toFixed(2)}`).join(" ");
  const fails = oks.map((ok, i) => (ok ? "" : `<rect x="${((i / (n - 1)) * 100 - 0.8).toFixed(2)}" y="0" width="1.6" height="24" fill="var(--critical)" opacity=".7"/>`)).join("");
  return `<svg class="mini-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-label="Javob vaqti">${fails}
    <polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// =============================================================== SITES
const sitesState = { list: [], range: Number(store("site-range") || 86400) };

async function loadSites() {
  const list = await api("/api/sites");
  sitesState.list = list;
  const up = list.filter((s) => s.status === "up").length, down = list.filter((s) => s.status === "down").length;
  const sslSoon = list.filter((s) => { const d = daysLeft(s.ssl_expires); return s.ssl_valid === false || (d != null && d <= 14); }).length;
  const msVals = list.map((s) => s.avg_ms_24h).filter((v) => v != null);
  const head = `<div class="detail-head"><div><h1>Saytlar</h1>
      <div class="meta"><span>Har bir sayt shu kompyuterdan, ya'ni foydalanuvchilar kabi tashqaridan tekshiriladi: ochiladimi, status kodi, javob vaqti, SSL muddati</span></div></div>
      <div class="row"><button class="btn ghost" id="check-all">Hammasini tekshirish</button><button class="btn primary" id="add-site">+ Sayt qo'shish</button></div></div>`;
  if (!list.length) {
    app.innerHTML = head + `<div class="empty-state"><h2>Hali sayt qo'shilmagan</h2>
      <p>Domeningizni qo'shing (masalan <code>example.uz</code> yoki <code>https://api.example.uz/health</code>). Sayt ishlamay qolsa yoki SSL sertifikat tugashiga oz qolsa, darhol ogohlantirish olasiz (Telegram ham).</p>
      <button class="btn primary" onclick="openSiteDialog()">+ Birinchi saytni qo'shish</button></div>`;
    bindSites();
    return;
  }
  const tiles = `<div class="tiles">
    <div class="tile"><div class="k">Jami saytlar</div><div class="v">${list.length}</div><div class="s">kuzatilmoqda</div></div>
    <div class="tile"><div class="k"><span class="badge light" style="padding:0;border:0;background:none">${ICONS.ok}</span>Ishlayapti</div><div class="v">${up}</div><div class="s">&nbsp;</div></div>
    <div class="tile"><div class="k"><span class="badge critical" style="padding:0;border:0;background:none">${ICONS.crit}</span>Ishlamayapti</div><div class="v">${down}</div><div class="s">${down ? "e'tibor bering!" : "hammasi ochilyapti"}</div></div>
    <div class="tile"><div class="k"><span class="badge heavy" style="padding:0;border:0;background:none">${ICONS.warn}</span>SSL ≤ 14 kun / xato</div><div class="v">${sslSoon}</div><div class="s">sertifikatni yangilang</div></div>
    <div class="tile"><div class="k">O'rtacha javob vaqti</div><div class="v">${msVals.length ? fmtMs(msVals.reduce((a, b) => a + b, 0) / msVals.length) : "—"}</div><div class="s">oxirgi 24 soat</div></div>
  </div>`;
  const rows = list.slice().sort((a, b) => (a.status === "down") === (b.status === "down") ? a.name.localeCompare(b.name) : a.status === "down" ? -1 : 1).map((s) => {
    const hint = s.status === "down" && s.server ? (s.server.status === "online"
      ? `<div class="hint">server <b>${esc(s.server.name)}</b> ishlayapti — nginx yoki backend ni tekshiring</div>`
      : `<div class="hint">server <b>${esc(s.server.name)}</b> ham javob bermayapti</div>`) : "";
    return `<tr class="link" data-site="${s.id}">
      <td>${siteBadge(s)}</td>
      <td><b>${esc(s.name)}</b><div class="muted mono" style="font-size:12px">${esc(s.url)}</div>${s.status === "down" ? `<div class="err-line">${esc(s.error)}</div>` : ""}${hint}</td>
      <td class="num">${s.code ? `<span class="st s${Math.floor(s.code / 100)}">${s.code}</span>` : "—"}</td>
      <td class="num">${fmtMs(s.ms)}</td>
      <td style="width:130px">${msSpark(s.spark, s.spark_ok)}</td>
      <td class="num">${s.uptime_24h != null ? s.uptime_24h.toFixed(2) + "%" : "—"}</td>
      <td class="num">${s.uptime_7d != null ? s.uptime_7d.toFixed(2) + "%" : "—"}</td>
      <td>${sslCell(s)}</td>
      <td>${s.server ? `<a href="#/server/${s.server.id}">${esc(s.server.name)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="num muted">${ago(s.last_check)}</td></tr>`;
  });
  app.innerHTML = head + tiles + table(["Holat", "Sayt", "Kod#", "Javob#", "Oxirgi tekshiruvlar", "Uptime 24s#", "Uptime 7k#", "SSL", "Server", "Tekshirildi#"], rows);
  bindSites();
}

function bindSites() {
  $("#add-site") && $("#add-site").addEventListener("click", () => openSiteDialog());
  $("#check-all") && $("#check-all").addEventListener("click", async () => {
    await Promise.all(sitesState.list.map((s) => api(`/api/sites/${s.id}/check`, { method: "POST" })));
    toast("Tekshirilmoqda…");
    setTimeout(refresh, 2500);
  });
  $$("tr[data-site]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = "#/site/" + tr.dataset.site; }));
}

async function loadSite(r) {
  const [s, hist] = await Promise.all([api("/api/sites/" + r.id), api(`/api/sites/${r.id}/history?range=${sitesState.range}`)]);
  const scrollY = window.scrollY;
  const d = daysLeft(s.ssl_expires);
  const ranges = [[3600, "1 soat"], [86400, "24 soat"], [7 * 86400, "7 kun"], [30 * 86400, "30 kun"]];
  app.innerHTML = `<a class="back" href="#/sites">← Barcha saytlar</a>
    <div class="detail-head"><div><h1>${esc(s.name)} ${siteBadge(s)}</h1>
      <div class="meta"><span><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></span>
        <span>Har <b>${s.interval}</b> s tekshiriladi</span>${s.keyword ? `<span>Kalit so'z: <b>${esc(s.keyword)}</b></span>` : ""}
        <span>IP: <b class="mono">${esc((s.ips || []).join(", ") || "—")}</b></span>
        ${s.server ? `<span>Server: <a href="#/server/${s.server.id}"><b>${esc(s.server.name)}</b></a></span>` : ""}
        <span>Tekshirildi: <b>${ago(s.last_check)}</b></span></div></div>
      <div class="row"><button class="btn ghost" id="site-check">Hozir tekshirish</button><button class="btn ghost" id="site-edit">Tahrirlash</button><button class="btn ghost danger" id="site-del">O'chirish</button></div></div>
    ${s.status === "down" ? `<div class="alert"><b>Sayt ochilmayapti:</b> ${esc(s.error)}${s.down_since ? " — " + ago(s.down_since).replace(" oldin", "") + " dan beri" : ""}</div>` : ""}
    <div class="tiles">
      <div class="tile"><div class="k">Status kodi</div><div class="v">${s.code || "—"}</div><div class="s">${s.status === "up" ? "javob to'g'ri" : esc(s.error || "—")}</div></div>
      <div class="tile"><div class="k">Javob vaqti</div><div class="v">${fmtMs(s.ms)}</div><div class="s">24 soat o'rtachasi: ${fmtMs(s.avg_ms_24h)}</div></div>
      <div class="tile"><div class="k">Uptime 24 soat</div><div class="v">${s.uptime_24h != null ? s.uptime_24h.toFixed(2) + "%" : "—"}</div><div class="s">7 kun: ${s.uptime_7d != null ? s.uptime_7d.toFixed(2) + "%" : "—"}</div></div>
      <div class="tile"><div class="k">SSL sertifikat</div><div class="v">${/^https:/i.test(s.url) ? (s.ssl_valid === false ? "Xato" : d != null ? d + " kun" : "…") : "—"}</div><div class="s">${esc(s.ssl_valid === false ? s.ssl_error : s.ssl_issuer || (s.ssl_expires ? fmtTime(s.ssl_expires, true) : "http — SSL yo'q"))}</div></div>
    </div>
    <div class="section-title">Javob vaqti <div class="seg" role="group">${ranges.map(([v, l]) => `<button data-srange="${v}" class="${v === sitesState.range ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="panels">${panel("Javob vaqti (ms)", `<div class="chart" id="site-chart"></div><div class="sub" style="margin-top:6px">Qizil chiziqlar — sayt ochilmagan paytlar</div>`, "wide")}
      ${panel("Hodisalar", renderEvents(s.events || [], false), "wide")}</div>`;
  const pts = hist.points;
  lineChart($("#site-chart"), { points: pts, series: [{ key: "ms", label: "Javob vaqti" }], fmt: (v) => fmtMs(v), title: "Javob vaqti" });
  const svg = $("#site-chart svg");
  if (svg && pts.length > 1) {
    const W = svg.viewBox.baseVal.width, t0 = pts[0].ts, span = Math.max(1, pts[pts.length - 1].ts - t0);
    const marks = pts.filter((p) => !p.ok).map((p) => `<rect x="${50 + ((p.ts - t0) / span) * (W - 58) - 1}" y="8" width="2" height="${svg.viewBox.baseVal.height - 30}" fill="var(--critical)" opacity=".45"/>`).join("");
    svg.insertAdjacentHTML("afterbegin", marks);
  }
  window.scrollTo(0, scrollY);
  $("#site-check").addEventListener("click", async () => { await api(`/api/sites/${s.id}/check`, { method: "POST" }); toast("Tekshirilmoqda…"); setTimeout(refresh, 2500); });
  $("#site-edit").addEventListener("click", () => openSiteDialog(s));
  $("#site-del").addEventListener("click", async () => {
    if (!confirm(`"${s.name}" saytini kuzatishdan olib tashlaysizmi?`)) return;
    await api("/api/sites/" + s.id, { method: "DELETE" });
    location.hash = "#/sites";
  });
  $$("[data-srange]").forEach((b) => b.addEventListener("click", () => { sitesState.range = Number(b.dataset.srange); store("site-range", sitesState.range); refresh(); }));
}

function openSiteDialog(site) {
  const dlg = $("#site-dialog"), f = $("#site-form");
  f.reset();
  $("#site-error").textContent = "";
  $("#site-dialog-title").textContent = site ? "Saytni tahrirlash" : "Sayt qo'shish";
  if (site) {
    f.elements.name.value = site.name; f.elements.url.value = site.url; f.elements.interval.value = String(site.interval);
    f.elements.keyword.value = site.keyword || ""; f.elements.timeout.value = site.timeout || 10; f.elements.group.value = site.group || "";
  }
  f.dataset.id = site ? site.id : "";
  dlg.showModal();
  setTimeout(() => f.elements.url.focus(), 30);
}
window.openSiteDialog = openSiteDialog;

// =============================================================== SETTINGS
async function loadSettings() {
  const s = await api("/api/settings");
  const hours = Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === s.tg_weekly_hour ? "selected" : ""}>${pad(i)}:00</option>`).join("");
  app.innerHTML = `<div class="detail-head"><div><h1>Sozlamalar</h1>
      <div class="meta"><span>Tokenlar faqat shu kompyuterda (dashboard/monitor.db) saqlanadi va hech qayerga yuborilmaydi</span></div></div></div>
    <div class="settings">
      <section class="panel"><h3>Telegram ogohlantirishlar ${s.tg_token_set && s.tg_chat ? `<span class="badge light">${ICONS.ok}Ulangan</span>` : `<span class="badge unknown">${ICONS.off}Ulanmagan</span>`}</h3>
        <ol class="steps">
          <li>Telegramda <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> ga <code>/newbot</code> yozing, botga nom bering — u <b>token</b> beradi.</li>
          <li>Yangi botingizni oching va unga <code>/start</code> yozing (guruhga yuborish uchun — botni guruhga qo'shing).</li>
          <li>Tokenni quyida joylang va <b>"Chat ID ni aniqlash"</b> ni bosing.</li>
        </ol>
        <div class="form-grid">
          <label class="full">Bot token<input id="tg-token" type="password" autocomplete="off" spellcheck="false" placeholder="${s.tg_token_set ? "saqlangan: " + esc(s.tg_token_hint) + " — o'zgartirish uchun yangisini yozing" : "123456789:AA..."}"></label>
          <label class="full">Chat ID
            <div class="row"><input id="tg-chat" value="${esc(s.tg_chat)}" autocomplete="off" placeholder="masalan 123456789"><button type="button" class="btn ghost" id="tg-find">Chat ID ni aniqlash</button></div>
            <div id="tg-chats" class="chips" style="margin-top:6px"></div></label>
        </div>
        <div class="sub">Qaysi hodisalar yuborilsin:</div>
        <div class="kinds">${s.event_kinds.map((k) => `<label class="chk"><input type="checkbox" value="${k.key}" ${s.tg_kinds.includes(k.key) ? "checked" : ""}>${esc(k.label)}</label>`).join("")}</div>
        <div class="sub" style="margin-top:12px">Haftalik hisobot (uptime, eng yuklangan serverlar, saytlar, hujumlar):</div>
        <div class="row" style="flex-wrap:wrap;align-items:center">
          <label class="chk"><input type="checkbox" id="tg-weekly" ${s.tg_weekly ? "checked" : ""}>Yuborilsin</label>
          <select id="tg-day" style="width:auto">${s.weekdays.map((d, i) => `<option value="${i}" ${i === s.tg_weekly_day ? "selected" : ""}>${d}</option>`).join("")}</select>
          <select id="tg-hour" style="width:auto">${hours}</select>
        </div>
        ${s.tg_last_error ? `<p class="form-error">Oxirgi xato: ${esc(s.tg_last_error)}</p>` : ""}
        <div class="row" style="margin-top:14px;flex-wrap:wrap">
          <button class="btn primary" id="tg-save">Saqlash</button>
          <button class="btn ghost" id="tg-test">Test xabar yuborish</button>
          <button class="btn ghost" id="rep-preview">Hisobotni ko'rish</button>
          <button class="btn ghost" id="rep-send">Hisobotni hozir yuborish</button>
        </div>
        <pre id="rep-box" class="report" hidden></pre>
      </section>

      <section class="panel"><h3>DigitalOcean ${s.do_token_set ? `<span class="badge light">${ICONS.ok}Ulangan</span>` : `<span class="badge unknown">${ICONS.off}Ulanmagan</span>`}</h3>
        <ol class="steps">
          <li><a href="https://cloud.digitalocean.com/account/api/tokens" target="_blank" rel="noopener">cloud.digitalocean.com → API → Tokens</a> → <b>Generate New Token</b>.</li>
          <li>Scope: <b>Read</b> (faqat o'qish) yetarli — dashboard hech narsani o'zgartirmaydi.</li>
          <li>Tokenni shu yerga joylang va saqlang. Keyin <a href="#/do">DigitalOcean</a> sahifasini oching.</li>
        </ol>
        <div class="form-grid"><label class="full">API token<input id="do-token" type="password" autocomplete="off" spellcheck="false" placeholder="${s.do_token_set ? "saqlangan: " + esc(s.do_token_hint) : "dop_v1_..."}"></label></div>
        <div class="row"><button class="btn primary" id="do-save">Saqlash</button>${s.do_token_set ? '<button class="btn ghost danger" id="do-clear">Tokenni o\'chirish</button>' : ""}</div>
      </section>

      <section class="panel"><h3>SSH (agentni avtomatik o'rnatish) ${s.ssh_available ? `<span class="badge light">${ICONS.ok}ssh bor</span>` : `<span class="badge critical">${ICONS.crit}ssh topilmadi</span>`}</h3>
        <p class="sub">Dashboard shu kompyuterdagi <code>ssh</code> buyrug'i va sizning SSH kalitingiz bilan ulanadi — parol kerak emas. Terminalda <code>ssh root@SERVER_IP</code> parol so'ramasdan kirsa, hammasi tayyor.</p>
        <div class="form-grid">
          <label>Standart foydalanuvchi<input id="ssh-user" value="${esc(s.ssh_user)}" autocomplete="off"></label>
          <label>SSH kalit fayli (ixtiyoriy)<input id="ssh-key" value="${esc(s.ssh_key)}" placeholder="bo'sh = ~/.ssh dagi standart kalitlar" autocomplete="off" spellcheck="false"></label>
        </div>
        <button class="btn primary" id="ssh-save">Saqlash</button>
      </section>
    </div>`;
  bindSettings(s);
}

function bindSettings(s) {
  const tgBody = () => {
    const b = { tg_chat: $("#tg-chat").value, tg_kinds: $$(".kinds input:checked").map((i) => i.value),
      tg_weekly: $("#tg-weekly").checked, tg_weekly_day: Number($("#tg-day").value), tg_weekly_hour: Number($("#tg-hour").value) };
    if ($("#tg-token").value.trim()) b.tg_token = $("#tg-token").value.trim();
    return b;
  };
  $("#tg-save").addEventListener("click", async () => { await api("/api/settings", { method: "POST", body: tgBody() }); toast("Saqlandi"); loadSettings(); });
  $("#tg-find").addEventListener("click", async () => {
    const r = await api("/api/telegram/chats", { method: "POST", body: { token: $("#tg-token").value.trim() } });
    const box = $("#tg-chats");
    if (r.error) { box.innerHTML = `<span class="form-error">${esc(r.error)}</span>`; return; }
    if (!r.chats.length) { box.innerHTML = `<span class="muted">Hech kim topilmadi — botingizga Telegramda /start yozing va qayta bosing.</span>`; return; }
    box.innerHTML = r.chats.map((c) => `<button type="button" class="chip pick" data-chat="${c.id}">${esc(c.name || c.type)} · ${c.id}</button>`).join("");
    $$("[data-chat]", box).forEach((b) => b.addEventListener("click", () => { $("#tg-chat").value = b.dataset.chat; toast("Chat ID tanlandi — Saqlash ni bosing"); }));
    if (r.chats.length === 1) $("#tg-chat").value = r.chats[0].id;
  });
  $("#tg-test").addEventListener("click", async () => {
    const r = await api("/api/telegram/test", { method: "POST", body: { token: $("#tg-token").value.trim(), chat: $("#tg-chat").value.trim() } });
    toast(r.ok ? "Test xabar yuborildi — Telegramni tekshiring" : "Xato: " + r.error);
  });
  $("#rep-preview").addEventListener("click", async () => {
    const r = await api("/api/report/preview");
    const box = $("#rep-box");
    box.hidden = false;
    box.textContent = r.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  });
  $("#rep-send").addEventListener("click", async () => {
    await api("/api/settings", { method: "POST", body: tgBody() });
    const r = await api("/api/report/send", { method: "POST" });
    toast(r.ok ? "Hisobot yuborildi" : "Xato: " + r.error);
  });
  $("#do-save").addEventListener("click", async () => {
    const v = $("#do-token").value.trim();
    if (!v) return toast("Token kiriting");
    await api("/api/settings", { method: "POST", body: { do_token: v } });
    toast("Saqlandi");
    location.hash = "#/do";
  });
  $("#do-clear") && $("#do-clear").addEventListener("click", async () => { await api("/api/settings", { method: "POST", body: { do_token: "" } }); loadSettings(); });
  $("#ssh-save").addEventListener("click", async () => {
    await api("/api/settings", { method: "POST", body: { ssh_user: $("#ssh-user").value, ssh_key: $("#ssh-key").value } });
    toast("Saqlandi");
  });
}

// =============================================================== DIGITALOCEAN
const doState = { data: null, refresh: false };

async function loadDO() {
  const d = await api("/api/do" + (doState.refresh ? "?refresh=1" : ""));
  doState.refresh = false;
  doState.data = d;
  const head = `<div class="detail-head"><div><h1>DigitalOcean</h1>
      <div class="meta"><span>Dropletlar, oylik xarajat va har biri uchun RAM/CPU bo'yicha tavsiya (oxirgi 7 kunlik monitoring asosida)</span></div></div>
      ${d.configured && !d.error ? `<div class="row"><button class="btn ghost" id="do-refresh">Yangilash</button></div>` : ""}</div>`;
  if (!d.configured) {
    app.innerHTML = head + `<div class="empty-state"><h2>DigitalOcean ulanmagan</h2>
      <p><a href="https://cloud.digitalocean.com/account/api/tokens" target="_blank" rel="noopener">cloud.digitalocean.com → API → Tokens</a> da <b>Read</b> huquqli token yarating va shu yerga joylang. Shundan so'ng barcha dropletlaringiz ko'rinadi va agentni bir tugma bilan o'rnatasiz.</p>
      <div class="row" style="max-width:520px;margin:0 auto"><input id="do-token-inline" type="password" placeholder="dop_v1_..." autocomplete="off"><button class="btn primary" id="do-token-save">Ulash</button></div></div>`;
    $("#do-token-save").addEventListener("click", async () => {
      const v = $("#do-token-inline").value.trim();
      if (!v) return;
      await api("/api/settings", { method: "POST", body: { do_token: v } });
      doState.refresh = true;
      refresh();
    });
    return;
  }
  if (d.error) {
    app.innerHTML = head + `<div class="alert"><b>DigitalOcean xatosi:</b> ${esc(d.error)}. <a href="#/settings">Sozlamalarda tokenni tekshiring</a>.</div>`;
    return;
  }
  const missing = d.droplets.filter((x) => !x.server_id && x.ip && x.status === "active");
  const cons = d.consolidation;
  const recBadge = (r) => !r ? "" : r.kind === "up" ? `<span class="badge critical">${ICONS.warn}Kattalashtiring</span>` : r.kind === "down" ? `<span class="badge heavy">${ICONS.info}Tejash mumkin</span>` : r.kind === "ok" ? `<span class="badge light">${ICONS.ok}Mos</span>` : "";
  const rows = d.droplets.map((x) => `<tr>
      <td><b>${esc(x.name)}</b><div class="muted" style="font-size:12px">${esc(x.region_name || x.region || "")} · ${esc(x.image)}</div></td>
      <td class="mono">${esc(x.ip || "—")}</td>
      <td><span class="mono">${esc(x.size)}</span><div class="muted" style="font-size:12px">${x.vcpus} vCPU · ${fmtMb(x.memory)} · ${x.disk} GB</div></td>
      <td class="num">${fmtUsd(x.price)}</td>
      <td>${x.server_id ? `<a href="#/server/${x.server_id}">${statusBadge({ status: x.server_status, summary: x.summary })}</a>`
        : x.ip ? `<button class="btn ghost small" data-do-install="${x.id}">Agent o'rnatish</button>` : '<span class="muted">—</span>'}</td>
      <td class="num">${x.usage ? fmtPct(x.usage.mem_p95) : "—"}</td>
      <td class="num">${x.usage ? fmtPct(x.usage.cpu_p95) : "—"}</td>
      <td class="rec">${recBadge(x.rec)} <span class="muted">${esc(x.rec ? x.rec.text : x.server_id ? "" : "monitoring yo'q")}</span></td></tr>`);
  app.innerHTML = head + `<div class="tiles">
      <div class="tile"><div class="k">Dropletlar</div><div class="v">${d.droplets.length}</div><div class="s">kuzatilmoqda: ${d.monitored} ta</div></div>
      <div class="tile"><div class="k">Oylik narx (jami)</div><div class="v">${fmtUsd(d.total_monthly)}</div><div class="s">droplet narxlari bo'yicha</div></div>
      <div class="tile"><div class="k">Shu oy sarflangan</div><div class="v">${d.month_to_date != null ? fmtUsd(d.month_to_date) : "—"}</div><div class="s">${d.month_to_date != null ? "DigitalOcean hisobi" : "token billing ni ko'rmaydi"}</div></div>
      <div class="tile"><div class="k">Tejash imkoniyati</div><div class="v">${d.savings ? fmtUsd(d.savings) : "—"}</div><div class="s">oyiga, tavsiyalar bo'yicha</div></div>
    </div>
    ${cons ? `<div class="panel wide cons"><h3>Birlashtirish tavsiyasi <span class="badge heavy">${ICONS.info}oyiga ${fmtUsd(cons.save)} tejash</span></h3>
      <p>${cons.count} ta kam yuklangan droplet (${cons.names.map(esc).join(", ")}) jami <b>~${fmtMb(cons.used_mb)}</b> RAM ishlatadi va oyiga <b>${fmtUsd(cons.cost)}</b> turadi.
      Ularni bitta <b class="mono">${esc(cons.slug)}</b> (${cons.vcpus} vCPU, ${fmtMb(cons.memory)}, ${cons.disk} GB) ga Docker Compose bilan ko'chirsangiz — <b>${fmtUsd(cons.price)}</b>/oy.
      Har bir loyihaga <code>mem_limit</code> qo'ying. Kamchiligi: bitta server o'chsa, hammasi to'xtaydi — Backups ni yoqing.</p></div>` : ""}
    ${missing.length ? `<div class="toolbar" style="margin-top:14px"><button class="btn primary" id="do-install-all">Kuzatilmayotgan ${missing.length} ta dropletga agent o'rnatish</button>
      <span class="muted">SSH kalitingiz bilan (Sozlamalar → SSH). Har biri uchun ~30 soniya.</span></div>` : ""}
    <div id="do-jobs"></div>
    ${table(["Droplet", "IP", "O'lcham", "Narx/oy#", "Monitoring", "RAM p95#", "CPU p95#", "Tavsiya"], rows, "Droplet topilmadi")}
    <p class="muted" style="font-size:12px;margin-top:8px">p95 — vaqtning 95% ida resurs shu qiymatdan oshmagan. Narxlar DigitalOcean API dan. Ma'lumot: ${ago(d.fetched)}.</p>`;
  $("#do-refresh").addEventListener("click", () => { doState.refresh = true; refresh(); });
  $$("[data-do-install]").forEach((b) => b.addEventListener("click", () => {
    const x = d.droplets.find((y) => String(y.id) === b.dataset.doInstall);
    openInstallDialog({ host: x.ip, name: x.name, group: "DigitalOcean" });
  }));
  $("#do-install-all") && $("#do-install-all").addEventListener("click", async () => {
    if (!confirm(`${missing.length} ta serverga SSH orqali agent o'rnatilsinmi?\n\n${missing.map((x) => x.name + " (" + x.ip + ")").join("\n")}`)) return;
    for (const x of missing) {
      try { await api("/api/install", { method: "POST", body: { host: x.ip, name: x.name, group: "DigitalOcean" } }); }
      catch (e) { toast(x.name + ": " + e.message); }
    }
    watchJobs();
  });
  renderJobs();
}

let jobsTimer = null;
async function renderJobs() {
  const box = $("#do-jobs");
  if (!box) return;
  const jobs = await api("/api/install");
  const recent = jobs.filter((j) => j.status === "running" || Date.now() / 1000 - (j.finished || 0) < 600);
  box.innerHTML = recent.length ? `<div class="panel wide" style="margin-bottom:12px"><h3>O'rnatish jarayonlari</h3>
    ${recent.map((j) => `<details class="job"><summary>${j.status === "ok" ? `<span class="badge light">${ICONS.ok}Tayyor</span>` : j.status === "error" ? `<span class="badge critical">${ICONS.crit}Xato</span>` : `<span class="badge normal">${ICONS.mid}Jarayonda</span>`}
      <b>${esc(j.name)}</b> <span class="muted mono">${esc(j.host)}</span> <span class="muted">${esc(j.log[j.log.length - 1] || "")}</span>
      ${j.server_id ? ` <a href="#/server/${j.server_id}">ochish →</a>` : ""}</summary><pre>${esc(j.log.join("\n"))}</pre></details>`).join("")}</div>` : "";
  return recent.some((j) => j.status === "running");
}
function watchJobs() {
  clearInterval(jobsTimer);
  jobsTimer = setInterval(async () => {
    if (!$("#do-jobs")) return clearInterval(jobsTimer);
    const running = await renderJobs();
    if (!running) { clearInterval(jobsTimer); doState.refresh = true; refresh(); }
  }, 2000);
}

// =============================================================== INSTALL DIALOG (SSH)
let installPoll = null;
async function openInstallDialog(pre) {
  const dlg = $("#install-dialog"), f = $("#install-form");
  f.reset();
  clearInterval(installPoll);
  $("#install-error").textContent = "";
  $("#install-log").hidden = true;
  $("#install-log").textContent = "";
  $("#install-submit").disabled = false;
  $("#install-open").hidden = true;
  try {
    const s = await api("/api/settings");
    f.elements.user.value = s.ssh_user || "root";
    f.elements.key.placeholder = s.ssh_key || "bo'sh = ~/.ssh dagi standart kalitlar";
    $("#install-nossh").hidden = s.ssh_available;
  } catch (e) { /* sozlamalar olinmasa ham davom etamiz */ }
  if (pre) Object.entries(pre).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v; });
  updateSshHint();
  dlg.showModal();
  setTimeout(() => f.elements[pre && pre.host ? "name" : "host"].focus(), 30);
}
window.openInstallDialog = openInstallDialog;

function updateSshHint() {
  const f = $("#install-form");
  const host = f.elements.host.value.trim() || "SERVER_IP", user = f.elements.user.value.trim() || "root";
  const port = f.elements.ssh_port.value && f.elements.ssh_port.value !== "22" ? " -p " + f.elements.ssh_port.value : "";
  const key = f.elements.key.value.trim() ? " -i " + f.elements.key.value.trim() : "";
  $("#install-ssh-cmd").textContent = `ssh${port}${key} ${user}@${host}`;
}

function bindInstallDialog() {
  const dlg = $("#install-dialog"), f = $("#install-form");
  f.addEventListener("input", updateSshHint);
  $("#install-cancel").addEventListener("click", () => { clearInterval(installPoll); dlg.close(); });
  $("#install-manual").addEventListener("click", () => { dlg.close(); openServerDialog(); });
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const e = f.elements;
    const body = { host: e.host.value, name: e.name.value, group: e.group.value, user: e.user.value, ssh_port: e.ssh_port.value,
      key: e.key.value, agent_port: e.agent_port.value, allow: e.allow.value };
    $("#install-error").textContent = "";
    let job;
    try { job = await api("/api/install", { method: "POST", body }); }
    catch (err) { $("#install-error").textContent = err.message; return; }
    $("#install-submit").disabled = true;
    const log = $("#install-log");
    log.hidden = false;
    clearInterval(installPoll);
    installPoll = setInterval(async () => {
      const j = await api("/api/install/" + job.id).catch(() => null);
      if (!j) return;
      log.textContent = j.log.join("\n");
      log.scrollTop = log.scrollHeight;
      if (j.status !== "running") {
        clearInterval(installPoll);
        $("#install-submit").disabled = false;
        if (j.status === "ok") {
          const open = $("#install-open");
          open.hidden = false;
          open.onclick = () => { dlg.close(); location.hash = "#/server/" + j.server_id; };
          toast("Agent o'rnatildi: " + j.name);
          if (state.route.name === "home" || state.route.name === "do") refresh();
        } else {
          $("#install-error").textContent = "O'rnatib bo'lmadi — yuqoridagi logni ko'ring";
        }
      }
    }, 1200);
  });
}

// =============================================================== LOGS
const logState = { source: "journal", q: "", n: 300, unit: "", level: "", auto: false, timer: null, data: null, server: null };
const LOG_PRESETS = [
  { label: "Faqat xatolar (journal)", source: "journal", level: "err", unit: "", q: "" },
  { label: "nginx xatolari", source: "nginx_error", level: "", unit: "", q: "" },
  { label: "SSH (sshd)", source: "journal", level: "", unit: "ssh", q: "" },
  { label: "Xato kirishlar", source: "auth", level: "", unit: "", q: "failed" },
  { label: "HTTP 5xx", source: "nginx_access", level: "", unit: "", q: "\" 50" },
  { label: "OOM (RAM tugashi)", source: "journal", level: "", unit: "", q: "out of memory" },
];

async function loadLogs(r) {
  clearTimeout(logState.timer);
  if (logState.server !== r.id) { logState.server = r.id; logState.data = null; }
  const srv = await api("/api/servers/" + r.id);
  if (!$("#log-page") || $("#log-page").dataset.id !== String(r.id)) {
    app.innerHTML = `<div id="log-page" data-id="${r.id}">
      <a class="back" href="#/server/${r.id}">← ${esc(srv.name)}</a>
      <div class="detail-head"><div><h1>Loglar — ${esc(srv.name)}</h1><div class="meta"><span class="mono">${esc(srv.host)}</span><span id="log-target" class="muted"></span></div></div></div>
      <div class="chips" style="margin-bottom:10px">${LOG_PRESETS.map((p, i) => `<button class="chip pick" data-preset="${i}">${esc(p.label)}</button>`).join("")}</div>
      <div class="toolbar log-toolbar">
        <select id="log-source" style="width:auto"><option value="journal">systemd journal</option></select>
        <input id="log-unit" placeholder="servis (masalan nginx, ssh, docker)" style="max-width:240px" autocomplete="off" spellcheck="false">
        <select id="log-level" style="width:auto"><option value="">barcha darajalar</option><option value="err">faqat xatolar</option><option value="warning">ogohlantirish va xatolar</option></select>
        <input id="log-q" type="search" placeholder="qidirish…" class="search" autocomplete="off">
        <select id="log-n" style="width:auto"><option value="100">100 qator</option><option value="300">300 qator</option><option value="1000">1000 qator</option><option value="2000">2000 qator</option></select>
        <button class="btn primary" id="log-go">Ko'rsatish</button>
        <label class="chk"><input type="checkbox" id="log-auto">har 10 s yangilash</label>
      </div>
      <div id="log-info" class="sub"></div>
      <pre id="log-out" class="logbox">Yuklanmoqda…</pre></div>`;
    $("#log-source").value = logState.source; $("#log-unit").value = logState.unit; $("#log-level").value = logState.level;
    $("#log-q").value = logState.q; $("#log-n").value = String(logState.n); $("#log-auto").checked = logState.auto;
    const read = () => {
      logState.source = $("#log-source").value; logState.unit = $("#log-unit").value.trim(); logState.level = $("#log-level").value;
      logState.q = $("#log-q").value; logState.n = Number($("#log-n").value); logState.auto = $("#log-auto").checked;
    };
    $("#log-go").addEventListener("click", () => { read(); fetchLogs(r.id); });
    $$("#log-q, #log-unit").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { read(); fetchLogs(r.id); } }));
    $$("#log-source, #log-level, #log-n").forEach((i) => i.addEventListener("change", () => { read(); fetchLogs(r.id); }));
    $("#log-auto").addEventListener("change", () => { read(); fetchLogs(r.id); });
    $$("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const p = LOG_PRESETS[Number(b.dataset.preset)];
      Object.assign(logState, { source: p.source, level: p.level, unit: p.unit, q: p.q });
      $("#log-source").value = p.source; $("#log-level").value = p.level; $("#log-unit").value = p.unit; $("#log-q").value = p.q;
      fetchLogs(r.id);
    }));
  }
  await fetchLogs(r.id);
}

async function fetchLogs(id) {
  clearTimeout(logState.timer);
  const qs = new URLSearchParams({ source: logState.source, n: logState.n });
  if (logState.q) qs.set("q", logState.q);
  if (logState.source === "journal" && logState.unit) qs.set("unit", logState.unit);
  if (logState.source === "journal" && logState.level) qs.set("level", logState.level);
  const out = $("#log-out");
  if (!out) return;
  let d;
  try { d = await api(`/api/servers/${id}/logs?${qs}`); }
  catch (e) { out.textContent = "Xato: " + e.message; return; }
  if (!$("#log-out")) return;
  const sel = $("#log-source");
  if (d.sources && d.sources.length) {
    const cur = logState.source;
    sel.innerHTML = d.sources.map((x) => `<option value="${x.key}" title="${esc(x.file || "")}">${esc(x.label)}</option>`).join("");
    sel.value = d.sources.some((x) => x.key === cur) ? cur : d.sources[0].key;
  }
  const journal = sel.value === "journal";
  $("#log-unit").hidden = !journal;
  $("#log-level").hidden = !journal;
  if (d.error) {
    out.textContent = d.error;
    $("#log-info").textContent = "";
  } else {
    const q = logState.q.trim().toLowerCase();
    out.innerHTML = d.lines.length ? d.lines.map((l) => {
      let h = esc(l);
      if (q) {
        const qq = esc(logState.q.trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        h = h.replace(new RegExp(qq, "gi"), (m) => `<mark>${m}</mark>`);
      }
      const bad = /\b(error|err|crit|fatal|fail(ed|ure)?|panic|denied|refused|out of memory|killed|segfault|emerg)\b|" 5\d\d /i.test(l);
      const warn = !bad && /\b(warn(ing)?|timeout|timed out|invalid)\b|" 4\d\d /i.test(l);
      return `<span class="${bad ? "l-bad" : warn ? "l-warn" : ""}">${h}</span>`;
    }).join("\n") : `<span class="muted">Mos qator topilmadi</span>`;
    out.scrollTop = out.scrollHeight;
    $("#log-target").textContent = d.target || "";
    $("#log-info").textContent = `${d.lines.length} ta qator ko'rsatildi` + (q ? ` · ${d.matched} ta mos keldi (${d.scanned} ta qator ichidan)` : "") + (d.limited ? " · oxirgilari" : "") + " · " + fmtTime(Date.now() / 1000);
  }
  if (logState.auto) logState.timer = setTimeout(() => fetchLogs(id), 10000);
}

// =============================================================== register
ROUTES.push(
  { re: /^#\/sites\/?$/, name: "sites", load: loadSites, interval: 15000 },
  { re: /^#\/site\/(\d+)/, name: "site", nav: "sites", load: loadSite, interval: 15000 },
  { re: /^#\/do\/?$/, name: "do", load: loadDO, interval: 0 },
  { re: /^#\/settings\/?$/, name: "settings", load: loadSettings, interval: 0 },
  { re: /^#\/logs\/(\d+)/, name: "logs", nav: "home", load: loadLogs, interval: 0 },
);
window.addEventListener("hashchange", () => clearTimeout(logState.timer));

(function bindSiteDialog() {
  const dlg = $("#site-dialog"), f = $("#site-form");
  $("#site-cancel").addEventListener("click", () => dlg.close());
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const e = f.elements;
    const body = { name: e.name.value, url: e.url.value, interval: Number(e.interval.value), keyword: e.keyword.value, timeout: Number(e.timeout.value), group: e.group.value };
    try {
      if (f.dataset.id) await api("/api/sites/" + f.dataset.id, { method: "PUT", body });
      else {
        const r = await api("/api/sites", { method: "POST", body });
        dlg.close();
        toast("Sayt qo'shildi — tekshirilmoqda…");
        location.hash = "#/site/" + r.id;
        return;
      }
      dlg.close();
      toast("Saqlandi");
      setTimeout(refresh, 1500);
    } catch (err) { $("#site-error").textContent = err.message; }
  });
})();
bindInstallDialog();

route();
