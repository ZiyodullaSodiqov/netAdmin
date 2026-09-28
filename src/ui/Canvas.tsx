// Topologiya maydoni (SVG): qurilmalar, kabellar, link LED lari, Wi-Fi qamrovi, paket animatsiyasi.
import { useRef, useState, type JSX } from 'react';
import { store, useStore, PROTO_COLORS } from './store';
import { DeviceIcon } from './icons';
import type { Device } from '../engine/device';
import type { Port } from '../engine/port';
import { CABLE_SPECS, Cable, wifiRssi } from '../engine/link';
import { describeFrame } from '../engine/packets';
import type { DeviceType } from '../engine/factory';
import { pingOnce, newIdent } from '../engine/cli/apps';

function portLed(p: Port): string {
  if (!p.adminUp || p.errDisabled) return '#ef4444';
  if (!p.operUp) return '#ef4444';
  const f = (p.device as any).fabric;
  if (p.switchport && f && f.stp.enabled) {
    const st = f.stp.portState(p);
    if (st === 'blocking' || st === 'listening' || st === 'learning') return '#f59e0b';
  }
  return '#22c55e';
}

function firstIp(d: Device): string | null {
  const st = (d as any).stack;
  if (!st) return null;
  const i = st.interfaces.find((x: any) => x.hasIp && x.up) ?? st.interfaces.find((x: any) => x.hasIp);
  return i?.ip ?? null;
}

export function Canvas() {
  const s = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const drag = useRef<{ kind: 'pan' | 'device'; startX: number; startY: number; vx: number; vy: number; dev?: Device; moved: boolean } | null>(null);
  const [picker, setPicker] = useState<{ device: Device; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const net = s.net;
  const v = s.view;

  const measure = (el: SVGSVGElement | null) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - size.w) > 2 || Math.abs(r.height - size.h) > 2) setSize({ w: r.width, h: r.height });
  };

  const toScreen = (x: number, y: number) => ({ x: (x - v.x) * v.scale + size.w / 2, y: (y - v.y) * v.scale + size.h / 2 });
  const toWorld = (sx: number, sy: number) => ({ x: (sx - size.w / 2) / v.scale + v.x, y: (sy - size.h / 2) / v.scale + v.y });

  const localXY = (e: React.MouseEvent | React.DragEvent | React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = localXY(e);
    const before = toWorld(p.x, p.y);
    const scale = Math.max(2, Math.min(60, v.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const nx = before.x - (p.x - size.w / 2) / scale;
    const ny = before.y - (p.y - size.h / 2) / scale;
    store.view = { x: nx, y: ny, scale };
    store.emit();
  };

  const onBgDown = (e: React.MouseEvent) => {
    setPicker(null);
    const p = localXY(e);
    if (s.tool.kind === 'place') {
      const w = toWorld(p.x, p.y);
      store.addDevice(s.tool.type, w.x, w.y);
      if (!e.shiftKey) store.setTool({ kind: 'select' });
      return;
    }
    drag.current = { kind: 'pan', startX: p.x, startY: p.y, vx: v.x, vy: v.y, moved: false };
    store.selected = null;
    store.cableStart = null;
    store.emit();
  };

  const onDeviceDown = (e: React.MouseEvent, d: Device) => {
    e.stopPropagation();
    const p = localXY(e);
    const tool = s.tool;
    if (tool.kind === 'delete') {
      store.removeDevice(d);
      return;
    }
    if (tool.kind === 'cable') {
      setPicker({ device: d, x: p.x, y: p.y });
      return;
    }
    if (tool.kind === 'pdu') {
      if (!store.pduStart) {
        if (!(d as any).stack) return store.notify("Bu qurilmadan ping yuborib bo'lmaydi", 'error');
        store.pduStart = d;
        store.notify(`${d.displayName} tanlandi — endi qabul qiluvchi qurilmani bosing`);
      } else {
        const src = store.pduStart;
        store.pduStart = null;
        const ip = firstIp(d);
        if (!ip) return store.notify(`${d.displayName} da IP manzil yo'q`, 'error');
        const st = (src as any).stack;
        store.notify(`${src.displayName} → ${d.displayName} (${ip}) ICMP echo yuborildi`);
        pingOnce(src, st, ip, { ident: newIdent(), seq: 1, size: 32, timeoutMs: 4000 }, (r) => {
          const txt: Record<string, string> = { reply: `✔ Javob keldi: ${ip} (${r.kind === 'reply' ? r.rtt.toFixed(2) : ''} ms)`, timeout: '✘ Javob kelmadi (timeout)', unreachable: '✘ Destination unreachable', 'ttl-exceeded': '✘ TTL tugadi', 'no-route': "✘ Marshrut yo'q (gateway?)", error: '✘ Xato' };
          store.notify(txt[r.kind], r.kind === 'reply' ? 'info' : 'error');
        });
      }
      store.emit();
      return;
    }
    store.selected = d;
    drag.current = { kind: 'device', startX: p.x, startY: p.y, vx: d.x, vy: d.y, dev: d, moved: false };
    store.emit();
  };

  const onMove = (e: React.MouseEvent) => {
    const p = localXY(e);
    setHover(toWorld(p.x, p.y));
    const dr = drag.current;
    if (!dr) return;
    const dx = (p.x - dr.startX) / v.scale;
    const dy = (p.y - dr.startY) / v.scale;
    if (Math.abs(p.x - dr.startX) + Math.abs(p.y - dr.startY) > 3) dr.moved = true;
    if (dr.kind === 'pan') {
      store.view = { ...v, x: dr.vx - dx, y: dr.vy - dy };
    } else if (dr.dev) {
      dr.dev.x = Math.round((dr.vx + dx) * 2) / 2;
      dr.dev.y = Math.round((dr.vy + dy) * 2) / 2;
    }
    store.emit();
  };

  const onUp = () => {
    const dr = drag.current;
    drag.current = null;
    if (dr?.kind === 'device' && dr.moved) {
      // masofa o'zgardi: kabel uzunligi va Wi-Fi signalini qayta hisoblash
      net.refresh();
      net.updateWireless();
    }
  };

  const pickPort = (port: Port) => {
    const tool = s.tool;
    if (tool.kind !== 'cable') return;
    setPicker(null);
    if (!store.cableStart) {
      store.cableStart = { device: port.device, port };
      store.notify(`${port.device.displayName} ${port.name} tanlandi — endi ikkinchi qurilmani bosing`);
      return;
    }
    const a = store.cableStart.port;
    store.cableStart = null;
    const r = net.connect(a, port, tool.cable === 'auto' ? undefined : tool.cable);
    if (typeof r === 'string') store.notify(r, 'error');
    else {
      const chk = r.check();
      store.notify(chk.ok ? `Ulandi: ${a.device.displayName} ${a.shortName} ↔ ${port.device.displayName} ${port.shortName} (${r.spec.label}, ${r.lengthM} m)` : `Ulandi, lekin link ishlamaydi: ${chk.reason}`, chk.ok ? 'info' : 'error');
    }
    store.emit();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/device') as DeviceType;
    if (!type) return;
    const p = localXY(e);
    const w = toWorld(p.x, p.y);
    store.addDevice(type, w.x, w.y);
  };

  // ------------------------------------------------------------------ chizish
  const now = performance.now();
  const grid: JSX.Element[] = [];
  const step = v.scale < 5 ? 25 : 5;
  const tl = toWorld(0, 0);
  const br = toWorld(size.w, size.h);
  for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
    const sx = toScreen(x, 0).x;
    grid.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={size.h} className={x % 25 === 0 ? 'grid-major' : 'grid-minor'} />);
  }
  for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
    const sy = toScreen(0, y).y;
    grid.push(<line key={`gy${y}`} x1={0} y1={sy} x2={size.w} y2={sy} className={y % 25 === 0 ? 'grid-major' : 'grid-minor'} />);
  }

  const cableEls = net.cables.map((c: Cable) => {
    const a = toScreen(c.a.device.x, c.a.device.y);
    const b = toScreen(c.b.device.x, c.b.device.y);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const off = Math.min(30, len / 3);
    const spec = CABLE_SPECS[c.type];
    const ok = c.check().ok;
    const act = (p: Port) => s.net.sim.now - p.lastActivity < 300 * Math.max(1, s.speed);
    const led = (p: Port, x: number, y: number) => (
      <g key={p.name}>
        <circle cx={x} cy={y} r={act(p) && p.operUp ? 5.5 : 4.5} fill={portLed(p)} stroke="#0b1220" strokeWidth={1} />
      </g>
    );
    const dash = c.type === 'console' ? '6 4' : c.type === 'copper-cross' ? '10 3' : undefined;
    return (
      <g key={c.id} className="cable">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ok ? spec.color : '#ef4444'} strokeWidth={c.type.startsWith('fiber') ? 3 : 2.2} strokeDasharray={dash} opacity={0.9} />
        {c.type !== 'console' && led(c.a, a.x + ux * off, a.y + uy * off)}
        {c.type !== 'console' && led(c.b, b.x - ux * off, b.y - uy * off)}
        {s.showLabels && v.scale > 7 && (
          <>
            <text x={a.x + ux * (off + 14)} y={a.y + uy * (off + 14) - 4} className="port-label">
              {c.a.shortName}
            </text>
            <text x={b.x - ux * (off + 14)} y={b.y - uy * (off + 14) - 4} className="port-label">
              {c.b.shortName}
            </text>
          </>
        )}
      </g>
    );
  });

  const wifiEls: JSX.Element[] = [];
  for (const m of net.wireless.values()) {
    const ap = m.apPort.device;
    const pa = toScreen(ap.x, ap.y);
    const cfg = ((ap as any).radios ?? []).find((r: any) => r.port === m.apPort)?.cfg;
    if (s.showCoverage && cfg && s.selected === ap) {
      // qamrov: RSSI -67 dBm (yaxshi) va -80 dBm (chegara)
      const radius = (target: number) => {
        let lo = 1;
        let hi = 400;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (wifiRssi(cfg.txPower, mid, cfg.band) > target) lo = mid;
          else hi = mid;
        }
        return lo * v.scale;
      };
      wifiEls.push(<circle key={`cov1${m.id}`} cx={pa.x} cy={pa.y} r={radius(-67)} className="wifi-cov good" />);
      wifiEls.push(<circle key={`cov2${m.id}`} cx={pa.x} cy={pa.y} r={radius(-82)} className="wifi-cov edge" />);
    }
    for (const [cp, info] of m.clients) {
      const pc = toScreen(cp.device.x, cp.device.y);
      const q = info.rssi > -60 ? '#22c55e' : info.rssi > -70 ? '#84cc16' : info.rssi > -78 ? '#f59e0b' : '#ef4444';
      wifiEls.push(
        <g key={`wl${m.id}${cp.device.id}`}>
          <line x1={pa.x} y1={pa.y} x2={pc.x} y2={pc.y} stroke={q} strokeDasharray="3 5" strokeWidth={1.6} />
          {v.scale > 8 && (
            <text x={(pa.x + pc.x) / 2} y={(pa.y + pc.y) / 2 - 4} className="port-label">
              {Math.round(info.rssi)} dBm · {info.rateMbps} Mb/s
            </text>
          )}
        </g>,
      );
    }
  }

  const animEls = s.anims.map((an, i) => {
    const r = an.rec;
    const a = toScreen(r.from.device.x, r.from.device.y);
    const b = toScreen(r.to.device.x, r.to.device.y);
    const k = Math.max(0, Math.min(1, (now - an.start) / an.dur));
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    const color = PROTO_COLORS[an.proto] ?? '#e2e8f0';
    return (
      <g key={i} transform={`translate(${x},${y})`} className="pdu" onClick={() => s.mode === 'simulation' && void 0}>
        <rect x={-9} y={-6} width={18} height={12} rx={2} fill={color} stroke="#0b1220" />
        <path d="M-9,-6 L0,1 L9,-6" fill="none" stroke="#0b1220" strokeWidth={1} />
      </g>
    );
  });

  const devEls = net.devices.map((d) => {
    const p = toScreen(d.x, d.y);
    const sel = s.selected === d || store.cableStart?.device === d || store.pduStart === d;
    const iconSize = Math.max(28, Math.min(60, v.scale * 3.2));
    const ips = s.showIps ? d.ipSummary().slice(0, 3) : [];
    return (
      <g
        key={d.id}
        transform={`translate(${p.x},${p.y})`}
        className={`device ${sel ? 'selected' : ''}`}
        onMouseDown={(e) => onDeviceDown(e, d)}
        onDoubleClick={() => store.openWindow(d)}
      >
        {sel && <circle r={iconSize * 0.62} className="sel-ring" />}
        <circle r={iconSize * 0.55} fill="transparent" />
        <DeviceIcon kind={d.kind} size={iconSize} off={!d.powered} />
        {!d.powered && (
          <text y={-iconSize * 0.45} className="dev-off" textAnchor="middle">
            ⏻ o'chiq
          </text>
        )}
        {s.showLabels && (
          <text y={iconSize * 0.55 + 12} className="dev-label" textAnchor="middle">
            {d.displayName}
          </text>
        )}
        {ips.map((t, i) => (
          <text key={i} y={iconSize * 0.55 + 25 + i * 11} className="dev-ip" textAnchor="middle">
            {t}
          </text>
        ))}
      </g>
    );
  });

  const scaleBar = (() => {
    const meters = v.scale > 20 ? 5 : v.scale > 8 ? 10 : v.scale > 4 ? 25 : 50;
    return (
      <g transform={`translate(16,${size.h - 18})`}>
        <line x1={0} y1={0} x2={meters * v.scale} y2={0} stroke="#94a3b8" strokeWidth={2} />
        <line x1={0} y1={-4} x2={0} y2={4} stroke="#94a3b8" />
        <line x1={meters * v.scale} y1={-4} x2={meters * v.scale} y2={4} stroke="#94a3b8" />
        <text x={meters * v.scale + 6} y={4} className="port-label">
          {meters} m
        </text>
      </g>
    );
  })();

  const cursor = s.tool.kind === 'cable' ? 'crosshair' : s.tool.kind === 'delete' ? 'not-allowed' : s.tool.kind === 'place' ? 'copy' : s.tool.kind === 'pdu' ? 'pointer' : 'default';

  return (
    <div className="canvas-wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <svg
        ref={(el) => {
          (svgRef as any).current = el;
          measure(el);
        }}
        className="canvas"
        style={{ cursor }}
        onMouseDown={onBgDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        onWheel={onWheel}
      >
        <g>{grid}</g>
        {net.walls.map((w, i) => {
          const a = toScreen(w.x1, w.y1);
          const b = toScreen(w.x2, w.y2);
          return <line key={`w${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wall" />;
        })}
        <g>{wifiEls}</g>
        <g>{cableEls}</g>
        <g>{devEls}</g>
        <g>{animEls}</g>
        {store.cableStart && hover && (
          <line
            x1={toScreen(store.cableStart.device.x, store.cableStart.device.y).x}
            y1={toScreen(store.cableStart.device.x, store.cableStart.device.y).y}
            x2={toScreen(hover.x, hover.y).x}
            y2={toScreen(hover.x, hover.y).y}
            stroke="#94a3b8"
            strokeDasharray="4 4"
          />
        )}
        {scaleBar}
      </svg>
      {picker && <PortPicker device={picker.device} x={picker.x} y={picker.y} onPick={pickPort} onClose={() => setPicker(null)} />}
      {hover && (
        <div className="coords">
          x: {hover.x.toFixed(1)} m · y: {hover.y.toFixed(1)} m
        </div>
      )}
    </div>
  );
}

function PortPicker({ device, x, y, onPick, onClose }: { device: Device; x: number; y: number; onPick: (p: Port) => void; onClose: () => void }) {
  const tool = store.tool;
  const cable = tool.kind === 'cable' ? tool.cable : 'auto';
  const media = cable === 'auto' ? null : CABLE_SPECS[cable].media;
  const ports = device.ports.filter((p) => p.media !== 'wireless');
  return (
    <div className="port-picker" style={{ left: x + 12, top: Math.max(8, y - 20) }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="pp-title">
        {device.displayName} — portni tanlang
        <button className="x" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pp-list">
        {ports.map((p) => {
          const busy = !!p.link;
          const wrong = media !== null && p.media !== media;
          return (
            <button key={p.name} disabled={busy || wrong} className={`pp-item ${busy ? 'busy' : ''}`} onClick={() => onPick(p)} title={wrong ? `${CABLE_SPECS[cable as keyof typeof CABLE_SPECS].label} bu portga mos emas` : ''}>
              <span className={`media ${p.media}`}>{p.media === 'fiber' ? 'SFP' : p.media === 'console' ? 'CON' : 'RJ45'}</span>
              <span className="pn">{p.label && p.label !== p.name ? `${p.name} (${p.label})` : p.name}</span>
              <span className="ps">{busy ? `→ ${p.peer?.device.displayName ?? ''}` : p.poeMaxW ? `PoE ${p.poeMaxW}W` : `${Math.max(...p.speeds) >= 1000 ? '1G' : Math.max(...p.speeds) ? '100M' : ''}`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { describeFrame };
