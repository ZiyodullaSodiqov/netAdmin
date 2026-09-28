// Asosiy oyna.
import { useRef } from 'react';
import { store, useStore, PROTO_COLORS, ALL_PROTOS } from './store';
import { Canvas } from './Canvas';
import { DeviceWindows } from './DeviceWindow';
import { DeviceIcon } from './icons';
import { CATALOG } from '../engine/factory';
import { SCENARIOS } from '../engine/scenarios';
import { CABLE_SPECS, CableType } from '../engine/link';
import { frameLayers } from '../engine/packets';
import { formatHms } from '../engine/util';
import { resetSessions } from './sessions';
import type { DeviceKind } from '../engine/device';

const KIND_OF: Record<string, DeviceKind> = {
  'router-2911': 'router',
  'router-4331': 'router',
  'router-1841': 'router',
  'switch-2960-24TT': 'switch',
  'switch-2960-24PS': 'switch',
  'switch-3560-24PS': 'l3switch',
  'switch-3650-24PS': 'l3switch',
};

export function App() {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const download = () => {
    const data = JSON.stringify(store.save(), null, 1);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(store.title || 'topologiya').replace(/[^\w\-]+/g, '_')}.netadmin.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openFile = (f: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        resetSessions();
        store.load(JSON.parse(String(r.result)));
        store.notify(`"${f.name}" yuklandi`);
      } catch (e: any) {
        store.notify(`Faylni o'qib bo'lmadi: ${e.message}`, 'error');
      }
    };
    r.readAsText(f);
  };

  const scenario = SCENARIOS.find((x) => x.id === s.scenarioId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⧉</span> NetAdmin <b>School</b>
        </div>
        <select
          className="lab-select"
          value={s.scenarioId}
          onChange={(e) => {
            resetSessions();
            store.loadScenario(e.target.value);
          }}
        >
          {!s.scenarioId && <option value="">{s.title}</option>}
          {SCENARIOS.map((sc) => (
            <option key={sc.id} value={sc.id}>
              {sc.title}
            </option>
          ))}
        </select>
        <button onClick={() => (resetSessions(), store.newEmpty())} title="Yangi bo'sh topologiya">
          ✚ Yangi
        </button>
        <button onClick={() => fileRef.current?.click()}>📂 Ochish</button>
        <button onClick={download}>💾 Saqlash</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
        <div className="sep" />
        <div className="mode-switch">
          <button className={s.mode === 'realtime' ? 'active' : ''} onClick={() => store.setMode('realtime')}>
            ⏱ Real vaqt
          </button>
          <button className={s.mode === 'simulation' ? 'active' : ''} onClick={() => store.setMode('simulation')}>
            🔬 Simulyatsiya
          </button>
        </div>
        <button className="icon-btn" onClick={() => ((store.running = !store.running), store.emit())} title={s.running ? 'Pauza' : 'Davom etish'}>
          {s.running ? '⏸' : '▶'}
        </button>
        {s.mode === 'simulation' && (
          <button onClick={() => store.stepOnce()} title="Keyingi hodisa">
            ⏭ Qadam
          </button>
        )}
        <select value={s.speed} onChange={(e) => ((store.speed = Number(e.target.value)), store.emit())} title="Tezlik">
          {[0.1, 0.25, 0.5, 1, 2, 5, 10].map((x) => (
            <option key={x} value={x}>
              {x}×
            </option>
          ))}
        </select>
        <button onClick={() => store.fastForward(30_000)} title="Vaqtni 30 soniya oldinga (STP, DHCP, OSPF uchun)">
          ⏩ +30s
        </button>
        <span className="clock" title="Simulyatsiya vaqti">
          🕒 {formatHms(s.net.sim.now)}
        </span>
        {s.lagging && <span className="lag">⚠ yuklama katta — simulyatsiya sekinlashdi</span>}
        <div className="spacer" />
        <label className="chk small">
          <input type="checkbox" checked={s.showIps} onChange={(e) => ((store.showIps = e.target.checked), store.emit())} /> IP
        </label>
        <label className="chk small">
          <input type="checkbox" checked={s.showLabels} onChange={(e) => ((store.showLabels = e.target.checked), store.emit())} /> Nomlar
        </label>
        <label className="chk small">
          <input type="checkbox" checked={s.showCoverage} onChange={(e) => ((store.showCoverage = e.target.checked), store.emit())} /> Wi-Fi qamrovi
        </label>
        <button onClick={() => (store.fitView(), store.emit())} title="Hammasini ko'rsatish">
          ⤢
        </button>
      </header>

      <aside className="palette">
        <div className="pal-section">
          <div className="pal-title">Asboblar</div>
          <div className="tools">
            <button className={s.tool.kind === 'select' ? 'active' : ''} onClick={() => store.setTool({ kind: 'select' })} title="Tanlash / surish (ikki marta bosish — oynani ochish)">
              ☝ Tanlash
            </button>
            <button className={s.tool.kind === 'pdu' ? 'active' : ''} onClick={() => store.setTool({ kind: 'pdu' })} title="Oddiy PDU: manba va qabul qiluvchini bosing — ICMP ping yuboriladi">
              ✉ Ping PDU
            </button>
            <button className={s.tool.kind === 'delete' ? 'active danger' : ''} onClick={() => store.setTool({ kind: 'delete' })} title="Qurilmani o'chirish">
              🗑 O'chirish
            </button>
          </div>
        </div>
        <div className="pal-section">
          <div className="pal-title">Kabellar</div>
          <div className="cables">
            <button className={s.tool.kind === 'cable' && s.tool.cable === 'auto' ? 'active' : ''} onClick={() => store.setTool({ kind: 'cable', cable: 'auto' })} title="Kabel turini avtomatik tanlash">
              <span className="cab" style={{ background: 'linear-gradient(90deg,#1f2937,#f97316,#38bdf8)' }} />
              Avtomatik
            </button>
            {(Object.keys(CABLE_SPECS) as CableType[]).map((t) => (
              <button key={t} className={s.tool.kind === 'cable' && s.tool.cable === t ? 'active' : ''} onClick={() => store.setTool({ kind: 'cable', cable: t })} title={CABLE_SPECS[t].description}>
                <span className={`cab ${t}`} style={{ background: CABLE_SPECS[t].color }} />
                {CABLE_SPECS[t].label.split(' (')[0].replace('Optika ', 'Optika ')}
              </button>
            ))}
          </div>
        </div>
        {(['Routerlar', 'Kommutatorlar', 'Simsiz', 'Telefoniya', 'Oxirgi qurilmalar'] as const).map((cat) => (
          <div className="pal-section" key={cat}>
            <div className="pal-title">{cat}</div>
            <div className="devs">
              {CATALOG.filter((c) => c.category === cat).map((c) => (
                <button
                  key={c.type}
                  className={`dev-item ${s.tool.kind === 'place' && s.tool.type === c.type ? 'active' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/device', c.type)}
                  onClick={() => store.setTool({ kind: 'place', type: c.type })}
                  title={`${c.name}\n${c.description}\n\nMaydonga torting yoki bosib, keyin maydonni bosing.`}
                >
                  <svg width={40} height={34} viewBox="-26 -22 52 44">
                    <DeviceIcon kind={KIND_OF[c.type] ?? (c.type as DeviceKind)} size={40} />
                  </svg>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </aside>

      <main className="stage">
        <Canvas />
        {s.tool.kind !== 'select' && (
          <div className="tool-hint">
            {s.tool.kind === 'cable' && (s.cableStart ? `${s.cableStart.device.displayName} ${s.cableStart.port.shortName} → ikkinchi qurilmani bosing` : 'Kabel: birinchi qurilmani bosing va portni tanlang')}
            {s.tool.kind === 'place' && 'Qurilmani joylashtirish uchun maydonni bosing (Shift — bir nechta)'}
            {s.tool.kind === 'delete' && "O'chirish uchun qurilmani bosing"}
            {s.tool.kind === 'pdu' && (s.pduStart ? `${s.pduStart.displayName} → qabul qiluvchini bosing` : 'Ping PDU: manba qurilmani bosing')}
            <button onClick={() => store.setTool({ kind: 'select' })}>Esc</button>
          </div>
        )}
      </main>

      <aside className="sidepanel">{s.mode === 'simulation' ? <SimPanel /> : <LabPanel scenario={scenario} />}</aside>

      <DeviceWindows />
      {s.toast && <div className={`toast ${s.toast.kind}`}>{s.toast.text}</div>}
    </div>
  );
}

function LabPanel({ scenario }: { scenario?: (typeof SCENARIOS)[number] }) {
  const s = useStore();
  const d = s.selected;
  return (
    <div className="lab">
      {scenario && (
        <>
          <h3>{scenario.title}</h3>
          <span className={`level l${scenario.level.length}`}>{scenario.level}</span>
          <p>{scenario.description}</p>
          <h4>Topshiriqlar</h4>
          <ol>
            {scenario.tasks.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </>
      )}
      {d && (
        <div className="sel-info">
          <h4>
            {d.displayName} <span className="dim">({d.model})</span>
          </h4>
          <div className="dim small">{d.powered ? (d.poweredViaPoe ? '⚡ PoE orqali ishlayapti' : '● Yoqiq') : "○ O'chiq"}</div>
          {d.ipSummary().map((x, i) => (
            <div key={i} className="mono small">
              {x}
            </div>
          ))}
          <div className="row">
            <button onClick={() => store.openWindow(d)}>Ochish</button>
            {(d.kind === 'router' || d.kind === 'switch' || d.kind === 'l3switch') && <button onClick={() => store.openWindow(d, 'cli')}>CLI</button>}
            {(d.kind === 'pc' || d.kind === 'laptop' || d.kind === 'server') && <button onClick={() => store.openWindow(d, 'desktop')}>Ish stoli</button>}
            <button className="danger" onClick={() => store.removeDevice(d)}>
              O'chirish
            </button>
          </div>
        </div>
      )}
      <div className="legend">
        <h4>Belgilar</h4>
        <div>
          <i className="dot" style={{ background: '#22c55e' }} /> Link ishlayapti (forwarding)
        </div>
        <div>
          <i className="dot" style={{ background: '#f59e0b' }} /> STP: listening / learning / blocking
        </div>
        <div>
          <i className="dot" style={{ background: '#ef4444' }} /> Link ishlamayapti yoki o'chirilgan
        </div>
        <div>
          <span className="cab-l" style={{ background: '#1f2937' }} /> Mis (Cat6) · <span className="cab-l dashed" /> kross
        </div>
        <div>
          <span className="cab-l" style={{ background: '#f97316' }} /> Optika MM · <span className="cab-l" style={{ background: '#eab308' }} /> SM
        </div>
        <div>
          <span className="cab-l dashed blue" /> Konsol kabeli
        </div>
        <p className="hint">Qurilmani ikki marta bosing — CLI, Ish stoli, sozlamalar. Kabellarni ulashda port turi, uzunlik (Cat6 ≤ 100 m) va MDI/MDI-X hisobga olinadi. PoE qurilmalari (IP telefon, AP) PoE switchga ulanishi yoki adapter bilan yoqilishi kerak.</p>
      </div>
    </div>
  );
}

function SimPanel() {
  const s = useStore();
  const sel = s.simSelected;
  const rows = s.simEvents.slice(-300);
  return (
    <div className="simpanel">
      <div className="sim-head">
        <h3>Hodisalar ro'yxati</h3>
        <button onClick={() => store.clearSimEvents()}>Tozalash</button>
      </div>
      <div className="filters">
        {ALL_PROTOS.map((p) => (
          <label key={p} className="flt" style={{ borderColor: PROTO_COLORS[p] }}>
            <input
              type="checkbox"
              checked={s.simFilter.has(p)}
              onChange={(e) => {
                if (e.target.checked) store.simFilter.add(p);
                else store.simFilter.delete(p);
                store.emit();
              }}
            />
            {p}
          </label>
        ))}
      </div>
      <div className="events">
        <table className="tbl small">
          <thead>
            <tr>
              <th>Vaqt (s)</th>
              <th>Qayerdan</th>
              <th>Qayerga</th>
              <th>Tur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`clickable ${sel === r ? 'sel' : ''}`} onClick={() => ((store.simSelected = r), store.emit())}>
                <td>{(r.t / 1000).toFixed(4)}</td>
                <td>{r.from}</td>
                <td>{r.to}</td>
                <td>
                  <i className="dot" style={{ background: PROTO_COLORS[r.proto] ?? '#999' }} /> {r.proto}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="hint">▶ yoki ⏭ Qadam tugmasini bosing. "Ping PDU" asbobi bilan paket yuboring yoki kompyuterdan ping qiling — har bir kadrning yo'li shu yerda ko'rinadi.</p>}
      </div>
      {sel && (
        <div className="pdu-details">
          <h4>
            PDU: {sel.from} {sel.rec.from.shortName} → {sel.to} {sel.rec.to.shortName}
          </h4>
          <div className="small">{sel.info}</div>
          {frameLayers(sel.rec.frame).map((l, i) => (
            <div key={i} className="layer">
              <div className="lname">{l.layer}</div>
              {l.lines.map((x, j) => (
                <div key={j} className="mono small">
                  {x}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
