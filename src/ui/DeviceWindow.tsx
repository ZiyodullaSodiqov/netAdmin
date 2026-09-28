// Qurilma oynasi: suriladigan (draggable) oyna, qurilma turiga qarab yorliqlar.
import { useRef, useState } from 'react';
import { store, useStore } from './store';
import type { Device } from '../engine/device';
import type { Port } from '../engine/port';
import { DeviceIcon } from './icons';
import { NetOsCliTab, NetOsConfigTab } from './tabs/NetOsTabs';
import { DesktopTab, ServicesTab, LoadTab } from './tabs/HostTabs';
import { PhoneTab } from './tabs/PhoneTab';
import { ApTab, HomeRouterTab } from './tabs/WirelessTabs';
import { CABLE_SPECS, Cable } from '../engine/link';
import { macCisco, formatBps } from '../engine/util';

interface TabDef {
  id: string;
  label: string;
  render: () => React.ReactNode;
}

function tabsFor(d: Device): TabDef[] {
  const phys: TabDef = { id: 'phys', label: 'Fizik', render: () => <PhysicalTab device={d} /> };
  switch (d.kind) {
    case 'router':
    case 'switch':
    case 'l3switch':
      return [phys, { id: 'config', label: 'Sozlash (GUI)', render: () => <NetOsConfigTab device={d as any} /> }, { id: 'cli', label: 'CLI', render: () => <NetOsCliTab device={d as any} /> }];
    case 'pc':
    case 'laptop':
    case 'smartphone':
    case 'printer':
      return [phys, { id: 'desktop', label: 'Ish stoli', render: () => <DesktopTab device={d as any} /> }];
    case 'server':
      return [
        phys,
        { id: 'desktop', label: 'Ish stoli', render: () => <DesktopTab device={d as any} /> },
        { id: 'services', label: 'Xizmatlar', render: () => <ServicesTab device={d as any} /> },
        { id: 'load', label: 'Yuklama', render: () => <LoadTab device={d as any} /> },
      ];
    case 'ipphone':
      return [{ id: 'phone', label: 'Telefon', render: () => <PhoneTab device={d as any} /> }, phys];
    case 'accesspoint':
      return [{ id: 'wifi', label: 'Wi-Fi', render: () => <ApTab device={d as any} /> }, phys];
    case 'homerouter':
      return [{ id: 'admin', label: 'Boshqaruv paneli', render: () => <HomeRouterTab device={d as any} /> }, phys];
    default:
      return [phys];
  }
}

export function DeviceWindows() {
  const s = useStore();
  return (
    <>
      {s.windows.map((w, i) => (
        <DeviceWindow key={w.id} device={w.device} index={i} initialTab={w.tab} />
      ))}
    </>
  );
}

function DeviceWindow({ device, index, initialTab }: { device: Device; index: number; initialTab?: string }) {
  useStore();
  const tabs = tabsFor(device);
  const [tab, setTab] = useState(initialTab ?? (tabs.find((t) => t.id === 'cli' || t.id === 'desktop' || t.id === 'phone' || t.id === 'wifi' || t.id === 'admin')?.id ?? tabs[0].id));
  const [pos, setPos] = useState({ x: 280 + index * 28, y: 70 + index * 24 });
  const [max, setMax] = useState(false);
  const drag = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0];
  const onDown = (e: React.MouseEvent) => {
    drag.current = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y };
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      setPos({ x: Math.max(0, drag.current.x + ev.clientX - drag.current.sx), y: Math.max(0, drag.current.y + ev.clientY - drag.current.sy) });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const focus = () => {
    if (store.windows[store.windows.length - 1]?.device !== device) store.openWindow(device);
  };
  return (
    <div className={`dev-window ${max ? 'max' : ''}`} style={max ? {} : { left: pos.x, top: pos.y }} onMouseDown={focus}>
      <div className="dw-title" onMouseDown={onDown} onDoubleClick={() => setMax(!max)}>
        <svg width={26} height={26} viewBox="-26 -26 52 52">
          <DeviceIcon kind={device.kind} size={44} />
        </svg>
        <span className="dw-name">{device.displayName}</span>
        <span className="dw-model">
          {device.model}
          {device.hostname !== device.label && device.kind !== 'pc' ? ` · hostname: ${device.hostname}` : ''}
        </span>
        <span className={`dw-power ${device.powered ? 'on' : 'off'}`}>{device.powered ? (device.poweredViaPoe ? '⚡ PoE' : '● yoqiq') : "○ o'chiq"}</span>
        <button className="dw-btn" title="Kattalashtirish" onClick={() => setMax(!max)}>
          ▢
        </button>
        <button className="dw-btn close" title="Yopish" onClick={() => store.closeWindow(device.id)}>
          ×
        </button>
      </div>
      <div className="dw-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={t.id === cur.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="dw-body">{cur.render()}</div>
    </div>
  );
}

// ======================================================================== Fizik yorliq

function PhysicalTab({ device }: { device: Device }) {
  const s = useStore();
  const [sel, setSel] = useState<Port | null>(null);
  const d = device;
  const isPd = d.poeRequiredW > 0;
  const togglePower = () => {
    d.powerSwitch = !d.powerSwitch;
    s.net.refresh();
    store.emit();
  };
  const toggleAc = () => {
    d.acPower = !d.acPower;
    s.net.refresh();
    store.emit();
  };
  const ports = d.ports;
  const port = sel && ports.includes(sel) ? sel : null;
  return (
    <div className="phys">
      <div className="phys-head">
        <div className="device-front">
          <button className={`power-btn ${d.powerSwitch ? 'on' : ''}`} onClick={togglePower} title="Quvvat tugmasi">
            ⏻
          </button>
          <div className="front-ports">
            {ports.map((p) => (
              <button key={p.name} className={`fp-port ${p.media} ${port === p ? 'sel' : ''}`} onClick={() => setSel(p)} title={`${p.name} — ${p.statusText}`}>
                <i className="led" style={{ background: p.media === 'console' ? '#64748b' : p.operUp ? (s.net.sim.now - p.lastActivity < 300 ? '#86efac' : '#22c55e') : p.link ? '#f59e0b' : '#1f2937' }} />
                <span>{p.label && p.label.length < 8 ? p.label : p.shortName.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="phys-info">
          <div>
            <b>Model:</b> {d.model}
          </div>
          <div>
            <b>Quvvat:</b> {d.powered ? (d.poweredViaPoe ? `PoE orqali (${d.poeRequiredW} Vt)` : 'Rozetka (AC)') : d.powerSwitch ? (isPd ? "Quvvat yo'q — PoE switch portiga ulang yoki adapterni yoqing" : "Rozetkaga ulanmagan") : "O'chirilgan"}
          </div>
          {isPd && (
            <label className="chk">
              <input type="checkbox" checked={d.acPower} onChange={toggleAc} /> Quvvat adapteri (rozetka) ulangan
            </label>
          )}
          {!isPd && d.kind !== 'smartphone' && d.kind !== 'laptop' && (
            <label className="chk">
              <input type="checkbox" checked={d.acPower} onChange={toggleAc} /> Rozetkaga ulangan
            </label>
          )}
          {(d as any).poeBudgetW > 0 && (
            <div>
              <b>PoE byudjeti:</b> {d.ports.reduce((a, p) => a + p.poeDrawW, 0).toFixed(1)} / {(d as any).poeBudgetW} Vt
            </div>
          )}
          <div className="row">
            <label>
              Nomi
              <input value={d.label} onChange={(e) => ((d.label = e.target.value), store.emit())} />
            </label>
            <label>
              X (m)
              <input type="number" value={d.x} onChange={(e) => ((d.x = Number(e.target.value)), s.net.refresh(), store.emit())} />
            </label>
            <label>
              Y (m)
              <input type="number" value={d.y} onChange={(e) => ((d.y = Number(e.target.value)), s.net.refresh(), store.emit())} />
            </label>
            <label>
              Qavat
              <input type="number" value={d.floor} onChange={(e) => ((d.floor = Number(e.target.value)), store.emit())} />
            </label>
          </div>
        </div>
      </div>
      {port ? (
        <>
          <button className="link-btn" onClick={() => setSel(null)}>
            ← Barcha portlar
          </button>
          <PortDetails port={port} />
        </>
      ) : (
        <PortTable device={d} onSelect={setSel} />
      )}
    </div>
  );
}

function PortTable({ device, onSelect }: { device: Device; onSelect: (p: Port) => void }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Port</th>
          <th>Turi</th>
          <th>Holat</th>
          <th>Tezlik</th>
          <th>VLAN</th>
          <th>Ulangan</th>
          <th>Trafik</th>
        </tr>
      </thead>
      <tbody>
        {device.ports.map((p) => {
          const c = p.link && p.link.kind === 'cable' ? (p.link as Cable) : null;
          const sp = p.switchport;
          return (
            <tr key={p.name} onClick={() => onSelect(p)} className="clickable">
              <td>{p.name}</td>
              <td>{p.media === 'fiber' ? 'SFP optika' : p.media === 'console' ? 'Konsol' : p.media === 'wireless' ? 'Wi-Fi radio' : `RJ45${p.poeMaxW ? ' PoE' : ''}${p.poePd ? ' (PD)' : ''}`}</td>
              <td className={p.operUp ? 'ok' : 'bad'}>{p.statusText}</td>
              <td>{p.operUp && p.operSpeed ? `${p.operSpeed >= 1000 ? p.operSpeed / 1000 + ' Gbit/s' : p.operSpeed + ' Mbit/s'}` : '—'}</td>
              <td>{sp ? (sp.operMode === 'trunk' ? `trunk (native ${sp.nativeVlan})` : `${sp.accessVlan}${sp.voiceVlan ? ` + voice ${sp.voiceVlan}` : ''}`) : p.media === 'console' ? '' : 'routed'}</td>
              <td>{c ? `${c.peerOf(p)!.device.displayName} ${c.peerOf(p)!.shortName} (${c.lengthM} m)` : p.media === 'wireless' ? `${(p.device.net.wireless.get(p)?.clients.size ?? (p.device.net.wifiAssociation(p) ? 1 : 0))} mijoz` : '—'}</td>
              <td>{p.operUp ? `↓${formatBps(p.rateIn)} ↑${formatBps(p.rateOut)}` : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PortDetails({ port }: { port: Port }) {
  const s = useStore();
  const c = port.link && port.link.kind === 'cable' ? (port.link as Cable) : null;
  const chk = c?.check();
  const assoc = port.media === 'wireless' ? s.net.wifiAssociation(port) : null;
  const f = (port.device as any).fabric;
  const stp = port.switchport && f ? f.stp.portState(port) : null;
  return (
    <div className="port-details">
      <div className="pd-grid">
        <div>
          <b>Port:</b> {port.name}
        </div>
        <div>
          <b>MAC:</b> {macCisco(port.mac)} ({port.mac})
        </div>
        <div>
          <b>Holat:</b> <span className={port.operUp ? 'ok' : 'bad'}>{port.statusText}</span>
          {port.errDisabled && ` (sabab: ${port.errDisabled})`}
        </div>
        <div>
          <b>Tezlik:</b> {port.operUp ? `${port.operSpeed} Mbit/s, full-duplex` : '—'} (qo'llab-quvvatlaydi: {port.speeds.join('/')} Mbit/s)
        </div>
        <div>
          <b>MDI:</b> {port.mdi} · Auto-MDIX: {port.autoMdix ? 'ha' : "yo'q"}
        </div>
        {port.poeMaxW > 0 && (
          <div>
            <b>PoE:</b> {port.poeEnabled ? 'auto' : "o'chirilgan"} · iste'mol: {port.poeDrawW} / {port.poeMaxW} Vt
          </div>
        )}
        {stp && (
          <div>
            <b>STP holati:</b> {stp}
          </div>
        )}
        {c && (
          <>
            <div>
              <b>Kabel:</b> {CABLE_SPECS[c.type].label} · {c.spec.standard}
            </div>
            <div>
              <b>Uzunlik:</b> {c.lengthM} m (maks. {c.spec.maxLengthM} m) · kechikish {(c.propagationMs * 1000).toFixed(2)} µs
            </div>
            <div>
              <b>Qarshi tomon:</b> {c.peerOf(port)!.device.displayName} {c.peerOf(port)!.name}
            </div>
            {!chk?.ok && <div className="bad">⚠ {chk?.reason}</div>}
            <div className="row">
              <label>
                Kabel uzunligi (m, bo'sh — avtomatik)
                <input type="number" value={c.manualLengthM ?? ''} placeholder={String(c.lengthM)} onChange={(e) => ((c.manualLengthM = e.target.value === '' ? null : Number(e.target.value)), s.net.refresh(), store.emit())} />
              </label>
              <button onClick={() => (s.net.disconnect(c), store.emit())}>Kabelni uzish</button>
            </div>
          </>
        )}
        {assoc && (
          <div>
            <b>Wi-Fi:</b> {assoc.medium.apPort.device.displayName} · {Math.round(assoc.rssi)} dBm · {assoc.rateMbps} Mbit/s
          </div>
        )}
        <div>
          <b>Hisoblagichlar:</b> RX {port.counters.rxFrames} kadr / {port.counters.rxBytes} B · TX {port.counters.txFrames} kadr / {port.counters.txBytes} B · drops {port.counters.outDrops}
        </div>
        <div>
          <b>Hozirgi trafik:</b> ↓ {formatBps(port.rateIn)} · ↑ {formatBps(port.rateOut)}
        </div>
      </div>
    </div>
  );
}
