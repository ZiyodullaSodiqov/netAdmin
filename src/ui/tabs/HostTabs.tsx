// Kompyuter / server: Ish stoli ilovalari, xizmatlar va yuklama monitoringi.
import { useState } from 'react';
import { store, useStore } from '../store';
import type { Host, Nic } from '../../engine/devices/host';
import { Terminal } from '../Terminal';
import { shellSession, consoleSession } from '../sessions';
import { httpFetch, LoadGenerator, FetchResult } from '../../engine/devices/host-apps';
import { LineChart, Meter } from '../Charts';
import { isValidIp, isValidMask, classfulMask, formatBytes } from '../../engine/util';
import type { WifiSecurity } from '../../engine/link';

type App = 'home' | 'ipconfig' | 'cmd' | 'browser' | 'wifi' | 'terminal' | 'traffic' | 'firewall';

export function DesktopTab({ device }: { device: Host }) {
  useStore();
  const [app, setApp] = useState<App>('home');
  if (!device.powered) return <div className="empty-note">Qurilma o'chirilgan.</div>;
  const apps: { id: App; icon: string; label: string; show: boolean }[] = [
    { id: 'ipconfig', icon: '🌐', label: 'IP sozlamalari', show: true },
    { id: 'cmd', icon: '⌨️', label: device.os === 'windows' ? 'Buyruqlar qatori' : 'Terminal (bash)', show: device.hostKind !== 'printer' },
    { id: 'browser', icon: '🧭', label: 'Web brauzer', show: device.hostKind !== 'printer' },
    { id: 'wifi', icon: '📶', label: 'Wi-Fi', show: !!device.wirelessNic },
    { id: 'terminal', icon: '🖧', label: 'Terminal (konsol)', show: device.ports.some((p) => p.media === 'console') },
    { id: 'traffic', icon: '📈', label: 'Yuklama generatori', show: device.hostKind === 'pc' || device.hostKind === 'laptop' || device.hostKind === 'server' },
    { id: 'firewall', icon: '🛡️', label: 'Firewall', show: device.hostKind !== 'printer' },
  ];
  if (app === 'home')
    return (
      <div className="desktop">
        {apps
          .filter((a) => a.show)
          .map((a) => (
            <button key={a.id} className="app-icon" onClick={() => setApp(a.id)}>
              <span className="ai">{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
      </div>
    );
  return (
    <div className="app-frame">
      <div className="app-bar">
        <button onClick={() => setApp('home')}>← Ish stoli</button>
        <b>{apps.find((a) => a.id === app)?.label}</b>
      </div>
      {app === 'ipconfig' && <IpConfigApp device={device} />}
      {app === 'cmd' && <Terminal session={shellSession(device)} height="auto" />}
      {app === 'browser' && <BrowserApp device={device} />}
      {app === 'wifi' && <WifiApp device={device} />}
      {app === 'terminal' && <ConsoleApp device={device} />}
      {app === 'traffic' && <TrafficApp device={device} />}
      {app === 'firewall' && (
        <div className="pad">
          <label className="chk">
            <input type="checkbox" checked={device.firewallIcmp} onChange={(e) => ((device.firewallIcmp = e.target.checked), store.emit())} /> ICMP Echo (ping) so'rovlariga javob berish
          </label>
          <p className="hint">Windows Defender Firewall odatda ping ni bloklaydi — agar ping ishlamasa, avval firewall ni tekshiring.</p>
        </div>
      )}
    </div>
  );
}

function IpConfigApp({ device }: { device: Host }) {
  useStore();
  return (
    <div className="pad">
      {device.nics.map((n) => (
        <NicForm key={n.port.name} device={device} nic={n} />
      ))}
      <GatewayForm device={device} />
    </div>
  );
}

function NicForm({ device, nic }: { device: Host; nic: Nic }) {
  const [ip, setIp] = useState(nic.cfg.ip);
  const [mask, setMask] = useState(nic.cfg.mask);
  const st = nic.iface.dhcpState;
  const setMode = (mode: 'dhcp' | 'static') => {
    device.setNicConfig(nic, { mode });
    store.emit();
  };
  const apply = () => {
    device.setNicConfig(nic, { mode: 'static', ip, mask: mask || (isValidIp(ip) ? classfulMask(ip) : '') });
    setMask(nic.cfg.mask);
    store.emit();
  };
  return (
    <fieldset className="nic">
      <legend>
        {nic.port.name} · MAC {nic.port.mac} · {nic.port.operUp ? <span className="ok">ulangan</span> : <span className="bad">kabel/Wi-Fi ulanmagan</span>}
      </legend>
      <div className="row">
        <label className="chk">
          <input type="radio" checked={nic.cfg.mode === 'dhcp'} onChange={() => setMode('dhcp')} /> DHCP
        </label>
        <label className="chk">
          <input type="radio" checked={nic.cfg.mode === 'static'} onChange={() => setMode('static')} /> Statik
        </label>
        {nic.cfg.mode === 'dhcp' && (
          <span className="hint">
            {st?.state === 'BOUND' ? `✔ DHCP: ${nic.iface.ip}/${nic.iface.prefix}, server ${st.server}` : st?.state === 'APIPA' ? `⚠ DHCP javob bermadi → APIPA ${nic.iface.ip}` : st ? `⏳ ${st.state}...` : ''}
            {nic.cfg.mode === 'dhcp' && (
              <button className="link-btn" onClick={() => (nic.dhcp.start(), store.emit())}>
                qayta so'rash
              </button>
            )}
          </span>
        )}
      </div>
      {nic.cfg.mode === 'static' ? (
        <div className="row">
          <label>
            IPv4 manzil
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.10" onBlur={() => !mask && isValidIp(ip) && setMask(classfulMask(ip))} />
          </label>
          <label>
            Maska
            <input value={mask} onChange={(e) => setMask(e.target.value)} placeholder="255.255.255.0" />
          </label>
          <button disabled={(ip !== '' && !isValidIp(ip)) || (mask !== '' && !isValidMask(mask))} onClick={apply}>
            Saqlash
          </button>
        </div>
      ) : (
        <div className="row dim">
          IP: {nic.iface.ip ?? '—'} · Maska: {nic.iface.mask ?? '—'}
        </div>
      )}
    </fieldset>
  );
}

function GatewayForm({ device }: { device: Host }) {
  const [gw, setGw] = useState(device.gateway);
  const [dns, setDns] = useState(device.dnsServer);
  return (
    <fieldset className="nic">
      <legend>Default gateway va DNS (statik rejim uchun)</legend>
      <div className="row">
        <label>
          Default gateway
          <input value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" />
        </label>
        <label>
          DNS server
          <input value={dns} onChange={(e) => setDns(e.target.value)} placeholder="8.8.8.8" />
        </label>
        <button
          onClick={() => {
            device.setGateway(gw);
            device.setDns(dns);
            store.emit();
          }}
        >
          Saqlash
        </button>
      </div>
      <div className="dim">
        Amaldagi: gateway {device.stack.defaultGateway ?? '—'} · DNS {device.stack.dnsServers.join(', ') || '—'}
      </div>
    </fieldset>
  );
}

function sanitize(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
}

function BrowserApp({ device }: { device: Host }) {
  const [url, setUrl] = useState('http://');
  const [res, setRes] = useState<FetchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const go = () => {
    setLoading(true);
    setRes(null);
    httpFetch(device, url.includes('://') ? url : `http://${url}`, (r) => {
      setLoading(false);
      setRes(r);
    });
  };
  return (
    <div className="browser">
      <div className="url-bar">
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <button onClick={go}>Ochish</button>
      </div>
      <div className="page">
        {loading && <div className="dim">⏳ Yuklanmoqda (DNS → TCP → HTTP)...</div>}
        {res && !res.ok && !res.status && <div className="bad">⚠ {res.error}</div>}
        {res && (res.ok || res.status) && (
          <>
            <iframe title="page" sandbox="" srcDoc={`<style>body{font-family:system-ui;padding:16px;color:#111}</style>${sanitize(res.body ?? '')}`} />
            <div className="dim small">
              HTTP {res.status} {res.statusText} · {formatBytes(res.size ?? 0)} · {res.ip} · DNS {res.timings?.dns.toFixed(1)} ms · TCP {res.timings?.connect.toFixed(1)} ms · javob {res.timings?.wait.toFixed(1)} ms · jami {res.ms.toFixed(1)} ms
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WifiApp({ device }: { device: Host }) {
  useStore();
  const [ssid, setSsid] = useState(device.wifi.ssid);
  const [key, setKey] = useState(device.wifi.key);
  const [sec, setSec] = useState<WifiSecurity>(device.wifi.security);
  const nic = device.wirelessNic!;
  const assoc = device.net.wifiAssociation(nic.port);
  const scan = device.scanWifi();
  const connect = (s = ssid, k = key, se = sec) => {
    device.wifi = { enabled: true, ssid: s, key: k, security: se };
    device.net.updateWireless();
    store.emit();
  };
  return (
    <div className="pad">
      <div className="wifi-status">
        {assoc ? (
          <span className="ok">
            ✔ Ulangan: "{device.wifi.ssid}" — {assoc.medium.apPort.device.displayName}, {Math.round(assoc.rssi)} dBm, {assoc.rateMbps} Mbit/s, IP {nic.iface.ip ?? '...'}
          </span>
        ) : device.wifi.ssid ? (
          <span className="bad">✘ "{device.wifi.ssid}" ga ulanib bo'lmadi (parol, xavfsizlik turi yoki signal)</span>
        ) : (
          <span className="dim">Ulanmagan</span>
        )}
      </div>
      <table className="tbl small">
        <thead>
          <tr>
            <th>SSID</th>
            <th>Signal</th>
            <th>Diapazon</th>
            <th>Kanal</th>
            <th>Xavfsizlik</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {scan.map((n, i) => (
            <tr key={i}>
              <td>{n.ssid}</td>
              <td>{n.rssi} dBm {'▂▄▆█'.slice(0, n.rssi > -55 ? 4 : n.rssi > -67 ? 3 : n.rssi > -75 ? 2 : 1)}</td>
              <td>{n.band}</td>
              <td>{n.channel}</td>
              <td>{n.security}</td>
              <td>
                <button onClick={() => (setSsid(n.ssid), setSec(n.security))}>Tanlash</button>
              </td>
            </tr>
          ))}
          {!scan.length && (
            <tr>
              <td colSpan={6} className="dim">
                Hech qanday Wi-Fi tarmoq topilmadi
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row">
        <label>
          SSID
          <input value={ssid} onChange={(e) => setSsid(e.target.value)} />
        </label>
        <label>
          Xavfsizlik
          <select value={sec} onChange={(e) => setSec(e.target.value as WifiSecurity)}>
            <option value="open">Ochiq</option>
            <option value="wpa2-psk">WPA2-Personal</option>
            <option value="wpa3-sae">WPA3-Personal</option>
          </select>
        </label>
        <label>
          Parol
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <button onClick={() => connect()}>Ulanish</button>
        <button onClick={() => ((device.wifi = { ...device.wifi, ssid: '' }), device.net.updateWireless(), store.emit())}>Uzish</button>
      </div>
    </div>
  );
}

function ConsoleApp({ device }: { device: Host }) {
  useStore();
  const s = consoleSession(device);
  if (typeof s === 'string')
    return (
      <div className="pad">
        <p className="bad">{s}</p>
        <p className="hint">Konsol kabeli (havorang, "Console") bilan kompyuterning RS 232 portini router/switch ning Console portiga ulang. Sozlamalar: 9600 baud, 8 data bit, parity yo'q, 1 stop bit.</p>
      </div>
    );
  return <Terminal session={s} height="auto" />;
}

function TrafficApp({ device }: { device: Host }) {
  useStore();
  const g = device.loadGens[0];
  const [url, setUrl] = useState(g?.url ?? 'http://10.10.10.100/api/data');
  const [rps, setRps] = useState(g?.rps ?? 50);
  const [inflight, setInflight] = useState(g?.maxInFlight ?? 200);
  const [dur, setDur] = useState(g?.durationSec ?? 60);
  const start = () => {
    device.loadGens.forEach((x) => x.stop());
    const ng = new LoadGenerator(device, url, rps, inflight, dur);
    device.loadGens = [ng];
    ng.start();
    store.emit();
  };
  const st = g?.stats;
  const avg = st && st.latencies.length ? st.latencies.reduce((a, b) => a + b, 0) / st.latencies.length : 0;
  return (
    <div className="pad">
      <div className="row">
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 240 }} />
        </label>
        <label>
          So'rov/s
          <input type="number" value={rps} onChange={(e) => setRps(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          Maks. parallel
          <input type="number" value={inflight} onChange={(e) => setInflight(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          Davomiylik (s, 0=∞)
          <input type="number" value={dur} onChange={(e) => setDur(Number(e.target.value))} style={{ width: 70 }} />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={start}>
          ▶ Boshlash
        </button>
        <button onClick={() => (g?.stop(), store.emit())} disabled={!g?.running}>
          ■ To'xtatish
        </button>
        {g?.running && <span className="ok">Ishlamoqda... ({g.inFlight} ta so'rov kutilmoqda)</span>}
      </div>
      {st && (
        <>
          <div className="stats-row">
            <div>
              <b>{st.sent}</b>yuborildi
            </div>
            <div className="ok">
              <b>{st.ok}</b>muvaffaqiyatli
            </div>
            <div className="bad">
              <b>{st.errors}</b>xato ({st.timeouts} timeout, {st.status5xx} × 5xx)
            </div>
            <div>
              <b>{avg.toFixed(1)} ms</b>o'rtacha
            </div>
            <div>
              <b>{g.percentile(95).toFixed(1)} ms</b>p95
            </div>
            <div>
              <b>{formatBytes(st.bytes)}</b>yuklab olindi
            </div>
          </div>
          <LineChart
            title="So'rovlar / soniya"
            series={[
              { label: 'yuborildi', color: '#60a5fa', values: st.history.map((h) => h.rps) },
              { label: 'OK', color: '#22c55e', values: st.history.map((h) => h.ok) },
              { label: 'xato', color: '#ef4444', values: st.history.map((h) => h.err) },
            ]}
          />
          <LineChart title="O'rtacha javob vaqti" unit=" ms" series={[{ label: 'latency', color: '#f59e0b', values: st.history.map((h) => h.avgMs) }]} />
        </>
      )}
    </div>
  );
}

// ======================================================================== Server xizmatlari

export function ServicesTab({ device }: { device: Host }) {
  useStore();
  const [svc, setSvc] = useState<'http' | 'dns' | 'dhcp' | 'syslog'>('http');
  return (
    <div className="services">
      <div className="svc-list">
        {(['http', 'dns', 'dhcp', 'syslog'] as const).map((s) => (
          <button key={s} className={svc === s ? 'active' : ''} onClick={() => setSvc(s)}>
            {s.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="svc-body">
        {svc === 'http' && <HttpSvc device={device} />}
        {svc === 'dns' && <DnsSvc device={device} />}
        {svc === 'dhcp' && <DhcpSvc device={device} />}
        {svc === 'syslog' && <SyslogSvc device={device} />}
      </div>
    </div>
  );
}

function HttpSvc({ device }: { device: Host }) {
  const h = device.http;
  const [path, setPath] = useState('/');
  const page = h.pages.get(path);
  const [np, setNp] = useState('');
  return (
    <div>
      <div className="row">
        <label className="chk">
          <input type="checkbox" checked={h.enabled} onChange={(e) => ((h.enabled = e.target.checked), store.emit())} /> HTTP (80)
        </label>
        <label className="chk">
          <input type="checkbox" checked={h.httpsEnabled} onChange={(e) => ((h.httpsEnabled = e.target.checked), store.emit())} /> HTTPS (443)
        </label>
        <label>
          Navbat chegarasi
          <input type="number" value={h.maxQueue} onChange={(e) => ((h.maxQueue = Number(e.target.value)), store.emit())} style={{ width: 80 }} />
        </label>
      </div>
      <div className="row">
        <select value={path} onChange={(e) => setPath(e.target.value)}>
          {[...h.pages.keys()].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input placeholder="/yangi-sahifa" value={np} onChange={(e) => setNp(e.target.value)} />
        <button
          onClick={() => {
            if (!np.startsWith('/')) return;
            h.pages.set(np, { path: np, title: np, body: `<h1>${np}</h1>`, size: 10_000, cpuMs: 5, dbMs: 0 });
            setPath(np);
            store.emit();
          }}
        >
          + Sahifa
        </button>
        {path !== '/' && <button onClick={() => (h.pages.delete(path), setPath('/'), store.emit())}>O'chirish</button>}
      </div>
      {page && (
        <div className="page-edit">
          <div className="row">
            <label>
              Sarlavha
              <input value={page.title} onChange={(e) => ((page.title = e.target.value), store.emit())} />
            </label>
            <label>
              Javob o'lchami (KB)
              <input type="number" value={Math.round(page.size / 1000)} onChange={(e) => ((page.size = Number(e.target.value) * 1000), store.emit())} style={{ width: 80 }} />
            </label>
            <label>
              CPU / so'rov (ms)
              <input type="number" value={page.cpuMs} onChange={(e) => ((page.cpuMs = Number(e.target.value)), store.emit())} style={{ width: 70 }} />
            </label>
            <label>
              Baza / so'rov (ms)
              <input type="number" value={page.dbMs} onChange={(e) => ((page.dbMs = Number(e.target.value)), store.emit())} style={{ width: 70 }} />
            </label>
          </div>
          <textarea value={page.body} onChange={(e) => ((page.body = e.target.value), store.emit())} rows={6} />
          <p className="hint">Statik sahifa ~2–5 ms CPU; dinamik (PHP/Python + ma'lumotlar bazasi) 20–100 ms. Bu qiymatlar server qancha foydalanuvchiga chidashini belgilaydi.</p>
        </div>
      )}
    </div>
  );
}

function DnsSvc({ device }: { device: Host }) {
  const d = device.dns;
  const [name, setName] = useState('');
  const [val, setVal] = useState('');
  const [type, setType] = useState<'A' | 'CNAME'>('A');
  return (
    <div>
      <label className="chk">
        <input type="checkbox" checked={d.enabled} onChange={(e) => (device.setDnsService(e.target.checked), store.emit())} /> DNS xizmati (UDP 53) · so'rovlar: {d.queries}
      </label>
      <table className="tbl small">
        <thead>
          <tr>
            <th>Nomi</th>
            <th>Turi</th>
            <th>Qiymat</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {d.records.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>{r.type}</td>
              <td>{r.value}</td>
              <td>
                <button onClick={() => (d.records.splice(i, 1), store.emit())}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input placeholder="www.misol.uz" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value as any)}>
          <option>A</option>
          <option>CNAME</option>
        </select>
        <input placeholder={type === 'A' ? '10.0.0.10' : 'www.misol.uz'} value={val} onChange={(e) => setVal(e.target.value)} />
        <button onClick={() => name && val && (d.records.push({ name, type, value: val, ttl: 3600 }), setName(''), setVal(''), store.emit())}>Qo'shish</button>
      </div>
    </div>
  );
}

function DhcpSvc({ device }: { device: Host }) {
  const pool = device.dhcpService.pools[0];
  const [f, setF] = useState({ gw: pool.defaultRouter ?? '', dns: pool.dns[0] ?? '', start: pool.startIp ?? '', mask: pool.mask || '255.255.255.0', max: pool.maxUsers ?? 100 });
  const save = () => {
    pool.defaultRouter = f.gw;
    pool.dns = f.dns ? [f.dns] : [];
    pool.startIp = f.start;
    pool.mask = f.mask;
    pool.network = isValidIp(f.start) && isValidMask(f.mask) ? f.start.split('.').map((x, i) => Number(x) & Number(f.mask.split('.')[i])).join('.') : '';
    pool.maxUsers = f.max;
    store.emit();
  };
  return (
    <div>
      <label className="chk">
        <input type="checkbox" checked={device.dhcpServiceEnabled} onChange={(e) => ((device.dhcpServiceEnabled = e.target.checked), store.emit())} /> DHCP xizmati (UDP 67)
      </label>
      <div className="row">
        <label>
          Default gateway
          <input value={f.gw} onChange={(e) => setF({ ...f, gw: e.target.value })} />
        </label>
        <label>
          DNS
          <input value={f.dns} onChange={(e) => setF({ ...f, dns: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label>
          Boshlang'ich IP
          <input value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
        </label>
        <label>
          Maska
          <input value={f.mask} onChange={(e) => setF({ ...f, mask: e.target.value })} />
        </label>
        <label>
          Maks. foydalanuvchi
          <input type="number" value={f.max} onChange={(e) => setF({ ...f, max: Number(e.target.value) })} style={{ width: 70 }} />
        </label>
        <button onClick={save}>Saqlash</button>
      </div>
      <h5>Berilgan manzillar</h5>
      <table className="tbl small">
        <tbody>
          {[...device.dhcpService.bindings.values()].map((b) => (
            <tr key={b.mac}>
              <td>{b.ip}</td>
              <td>{b.mac}</td>
              <td>{b.hostname ?? ''}</td>
              <td>{b.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Boshqa VLAN dagi mijozlar uchun routerda "ip helper-address {device.nics[0].iface.ip ?? 'server IP'}" sozlang (DHCP relay).</p>
    </div>
  );
}

function SyslogSvc({ device }: { device: Host }) {
  const s = device.syslogService;
  return (
    <div>
      <label className="chk">
        <input type="checkbox" checked={s.enabled} onChange={(e) => ((s.enabled = e.target.checked), store.emit())} /> Syslog server (UDP 514)
      </label>
      <p className="hint">Routerda: logging host {device.nics[0].iface.ip ?? '<server IP>'}</p>
      <pre className="ios-log">{s.entries.map((e) => `${(e.t / 1000).toFixed(1)}s  ${e.from}  ${e.text}`).join('\n') || "Hali xabar yo'q"}</pre>
    </div>
  );
}

// ======================================================================== Yuklama

export function LoadTab({ device }: { device: Host }) {
  useStore();
  const h = device.http;
  const hist = h.history;
  const hw = device.hardware;
  const cur = h.current;
  const set = (k: keyof typeof hw, v: number) => {
    (hw as any)[k] = v;
    store.emit();
  };
  return (
    <div className="pad load-tab">
      <div className="row">
        <label>
          CPU yadrolari
          <input type="number" min={1} max={128} value={hw.cpuCores} onChange={(e) => set('cpuCores', Math.max(1, Number(e.target.value)))} style={{ width: 70 }} />
        </label>
        <label>
          Chastota (GHz)
          <input type="number" step={0.1} value={hw.cpuGhz} onChange={(e) => set('cpuGhz', Math.max(0.5, Number(e.target.value)))} style={{ width: 70 }} />
        </label>
        <label>
          RAM (GB)
          <input type="number" value={hw.ramMb / 1024} onChange={(e) => set('ramMb', Math.max(1, Number(e.target.value)) * 1024)} style={{ width: 70 }} />
        </label>
        <label>
          Disk IOPS
          <input type="number" value={hw.diskIops} onChange={(e) => set('diskIops', Math.max(50, Number(e.target.value)))} style={{ width: 80 }} />
        </label>
      </div>
      <div className="meters">
        <Meter label="CPU" value={cur.cpu} color="#22c55e" />
        <Meter label="RAM" value={cur.ram} color="#3b82f6" />
      </div>
      <div className="stats-row">
        <div>
          <b>{cur.rps}</b>so'rov/s
        </div>
        <div>
          <b>{cur.latencyMs.toFixed(1)} ms</b>server javob vaqti
        </div>
        <div>
          <b>{cur.queue}</b>navbatda
        </div>
        <div>
          <b>{cur.active}</b>TCP ulanish
        </div>
        <div className={cur.errors ? 'bad' : ''}>
          <b>{cur.errors}</b>503 xato/s
        </div>
        <div>
          <b>{cur.netOutMbps.toFixed(1)} Mbit/s</b>chiquvchi trafik
        </div>
      </div>
      <LineChart title="CPU va RAM" unit="%" max={100} series={[{ label: 'CPU', color: '#22c55e', values: hist.map((x) => x.cpu) }, { label: 'RAM', color: '#3b82f6', values: hist.map((x) => x.ram) }]} />
      <LineChart title="So'rovlar / s va xatolar" series={[{ label: 'req/s', color: '#60a5fa', values: hist.map((x) => x.rps) }, { label: '503/s', color: '#ef4444', values: hist.map((x) => x.errors) }]} />
      <LineChart title="Javob vaqti (server ichida)" unit=" ms" series={[{ label: 'latency', color: '#f59e0b', values: hist.map((x) => x.latencyMs) }, { label: 'navbat', color: '#a855f7', values: hist.map((x) => x.queue) }]} />
      <LineChart title="Tarmoq" unit=" Mb" series={[{ label: 'kiruvchi', color: '#06b6d4', values: hist.map((x) => x.netInMbps) }, { label: 'chiquvchi', color: '#f472b6', values: hist.map((x) => x.netOutMbps) }]} />
      <div className="dim small">
        Jami: {h.totals.requests} so'rov · {h.totals.ok} OK · {h.totals.errors} xato · {formatBytes(h.totals.bytesOut)} yuborildi
      </div>
    </div>
  );
}
