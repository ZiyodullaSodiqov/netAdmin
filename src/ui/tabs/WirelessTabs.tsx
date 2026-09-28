// Access Point va uy Wi-Fi routeri sozlamalari.
import { useState } from 'react';
import { store, useStore } from '../store';
import type { AccessPoint, HomeRouter, RadioConfig } from '../../engine/devices/wireless';
import type { Port } from '../../engine/port';
import type { WifiSecurity } from '../../engine/link';

function RadioForm({ cfg, onChange, showVlan }: { cfg: RadioConfig; onChange: (c: RadioConfig) => void; showVlan: boolean }) {
  const [c, setC] = useState(cfg);
  const channels = cfg.band === '2.4GHz' ? [1, 6, 11] : [36, 40, 44, 48, 149, 153, 157, 161];
  return (
    <fieldset className="nic">
      <legend>
        {cfg.band} radio {c.enabled ? '🟢' : '⚪'}
      </legend>
      <div className="row">
        <label className="chk">
          <input type="checkbox" checked={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.checked })} /> Yoqilgan
        </label>
        <label>
          SSID
          <input value={c.ssid} onChange={(e) => setC({ ...c, ssid: e.target.value })} />
        </label>
        <label>
          Kanal
          <select value={c.channel} onChange={(e) => setC({ ...c, channel: Number(e.target.value) })}>
            {channels.map((ch) => (
              <option key={ch}>{ch}</option>
            ))}
          </select>
        </label>
        <label>
          Quvvat (dBm)
          <input type="number" min={1} max={30} value={c.txPower} onChange={(e) => setC({ ...c, txPower: Number(e.target.value) })} style={{ width: 60 }} />
        </label>
      </div>
      <div className="row">
        <label>
          Xavfsizlik
          <select value={c.security} onChange={(e) => setC({ ...c, security: e.target.value as WifiSecurity })}>
            <option value="open">Ochiq (xavfsiz emas!)</option>
            <option value="wpa2-psk">WPA2-Personal (AES)</option>
            <option value="wpa3-sae">WPA3-Personal (SAE)</option>
          </select>
        </label>
        {c.security !== 'open' && (
          <label>
            Parol (min 8)
            <input value={c.key} onChange={(e) => setC({ ...c, key: e.target.value })} />
          </label>
        )}
        {showVlan && (
          <label>
            VLAN (bo'sh — native)
            <input value={c.vlan ?? ''} onChange={(e) => setC({ ...c, vlan: e.target.value ? Number(e.target.value) : null })} style={{ width: 70 }} />
          </label>
        )}
        <label className="chk">
          <input type="checkbox" checked={c.broadcastSsid} onChange={(e) => setC({ ...c, broadcastSsid: e.target.checked })} /> SSID ko'rinadi
        </label>
        <button disabled={c.security !== 'open' && c.key.length < 8} onClick={() => onChange(c)}>
          Saqlash
        </button>
      </div>
    </fieldset>
  );
}

function Clients({ radios }: { radios: { port: Port }[] }) {
  useStore();
  const rows: { name: string; rssi: number; rate: number; band: string; ip: string }[] = [];
  for (const r of radios) {
    const m = store.net.wireless.get(r.port);
    if (!m) continue;
    for (const [cp, info] of m.clients) {
      const ip = (cp.device as any).stack?.interfaces.find((i: any) => i.port === cp)?.ip ?? '—';
      rows.push({ name: cp.device.displayName, rssi: info.rssi, rate: info.rateMbps, band: r.port.label ?? '', ip });
    }
  }
  return (
    <table className="tbl small">
      <thead>
        <tr>
          <th>Mijoz</th>
          <th>Diapazon</th>
          <th>Signal</th>
          <th>Tezlik</th>
          <th>IP</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.name}</td>
            <td>{r.band}</td>
            <td className={r.rssi > -67 ? 'ok' : r.rssi > -78 ? '' : 'bad'}>{Math.round(r.rssi)} dBm</td>
            <td>{r.rate} Mbit/s</td>
            <td>{r.ip}</td>
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colSpan={5} className="dim">
              Ulangan mijoz yo'q
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function ApTab({ device }: { device: AccessPoint }) {
  useStore();
  if (!device.powered) return <div className="empty-note">Access Point quvvatsiz. PoE qo'llab-quvvatlaydigan switch portiga (masalan 2960-24PS) ulang yoki "Fizik" yorlig'ida adapterni yoqing.</div>;
  return (
    <div className="pad">
      {device.radios.map((r, i) => (
        <RadioForm
          key={i + r.cfg.band}
          cfg={r.cfg}
          showVlan
          onChange={(c) => {
            r.cfg = c;
            device.applyRadioVlans();
            device.net.updateWireless();
            store.emit();
          }}
        />
      ))}
      <div className="dim small">
        Boshqaruv IP (BVI1): {device.mgmt.ip ?? '—'} {device.mgmt.dhcp ? '(DHCP)' : ''} · Uplink: {device.uplink.switchport?.operMode === 'trunk' ? `trunk (${[...((device.uplink.switchport.allowedVlans as Set<number>) ?? [])].join(',')})` : 'access'}
      </div>
      <h4>Ulangan mijozlar</h4>
      <Clients radios={device.radios} />
    </div>
  );
}

export function HomeRouterTab({ device }: { device: HomeRouter }) {
  useStore();
  const [sec, setSec] = useState<'status' | 'wan' | 'lan' | 'wifi' | 'fw'>('status');
  const [c, setC] = useState({ ...device.cfg });
  const save = () => {
    device.cfg = { ...c };
    device.applyConfig();
    store.emit();
  };
  if (!device.powered) return <div className="empty-note">Router o'chirilgan.</div>;
  return (
    <div className="homerouter">
      <div className="hr-nav">
        {(
          [
            ['status', 'Holat'],
            ['wan', 'Internet (WAN)'],
            ['lan', 'LAN / DHCP'],
            ['wifi', 'Wi-Fi'],
            ['fw', 'Port forwarding'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={sec === k ? 'active' : ''} onClick={() => setSec(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="hr-body">
        {sec === 'status' && (
          <div>
            <div className="stats-row">
              <div>
                <b>{device.wanIface.ip ?? '—'}</b>WAN IP {device.cfg.wanMode === 'dhcp' ? '(DHCP)' : ''}
              </div>
              <div>
                <b>{device.lanIface.ip}</b>LAN IP
              </div>
              <div>
                <b>{[...device.dhcpServer.bindings.values()].filter((b) => b.state === 'bound').length}</b>DHCP mijozlar
              </div>
              <div>
                <b>{device.stack.nat.entries.length}</b>NAT tarjimalar
              </div>
            </div>
            <div className="dim">
              Gateway: {device.stack.routes().find((r) => r.prefix === 0)?.nextHop ?? '—'} · DNS: {device.stack.dnsServers.join(', ') || '—'}
            </div>
            <h4>DHCP mijozlar</h4>
            <table className="tbl small">
              <tbody>
                {[...device.dhcpServer.bindings.values()]
                  .filter((b) => b.state === 'bound')
                  .map((b) => (
                    <tr key={b.mac}>
                      <td>{b.hostname ?? '?'}</td>
                      <td>{b.ip}</td>
                      <td>{b.mac}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <h4>Wi-Fi mijozlar</h4>
            <Clients radios={device.radios} />
          </div>
        )}
        {sec === 'wan' && (
          <div>
            <div className="row">
              <label className="chk">
                <input type="radio" checked={c.wanMode === 'dhcp'} onChange={() => setC({ ...c, wanMode: 'dhcp' })} /> Avtomatik (DHCP)
              </label>
              <label className="chk">
                <input type="radio" checked={c.wanMode === 'static'} onChange={() => setC({ ...c, wanMode: 'static' })} /> Statik IP
              </label>
            </div>
            {c.wanMode === 'static' && (
              <div className="row">
                <label>
                  IP
                  <input value={c.wanIp} onChange={(e) => setC({ ...c, wanIp: e.target.value })} />
                </label>
                <label>
                  Maska
                  <input value={c.wanMask} onChange={(e) => setC({ ...c, wanMask: e.target.value })} />
                </label>
                <label>
                  Gateway
                  <input value={c.wanGw} onChange={(e) => setC({ ...c, wanGw: e.target.value })} />
                </label>
                <label>
                  DNS
                  <input value={c.wanDns} onChange={(e) => setC({ ...c, wanDns: e.target.value })} />
                </label>
              </div>
            )}
            <button onClick={save}>Saqlash</button>
          </div>
        )}
        {sec === 'lan' && (
          <div>
            <div className="row">
              <label>
                Router IP
                <input value={c.lanIp} onChange={(e) => setC({ ...c, lanIp: e.target.value })} />
              </label>
              <label>
                Maska
                <input value={c.lanMask} onChange={(e) => setC({ ...c, lanMask: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="chk">
                <input type="checkbox" checked={c.dhcpEnabled} onChange={(e) => setC({ ...c, dhcpEnabled: e.target.checked })} /> DHCP server
              </label>
              <label>
                Boshlang'ich IP
                <input value={c.dhcpStart} onChange={(e) => setC({ ...c, dhcpStart: e.target.value })} />
              </label>
              <label>
                Maks. mijoz
                <input type="number" value={c.dhcpMax} onChange={(e) => setC({ ...c, dhcpMax: Number(e.target.value) })} style={{ width: 70 }} />
              </label>
            </div>
            <button onClick={save}>Saqlash</button>
          </div>
        )}
        {sec === 'wifi' &&
          device.radios.map((r, i) => (
            <RadioForm
              key={i}
              cfg={r.cfg}
              showVlan={false}
              onChange={(cfg) => {
                r.cfg = cfg;
                device.applyRadios();
                device.net.updateWireless();
                store.emit();
              }}
            />
          ))}
        {sec === 'fw' && <PortForwards device={device} />}
      </div>
    </div>
  );
}

function PortForwards({ device }: { device: HomeRouter }) {
  const [f, setF] = useState({ proto: 'tcp' as 'tcp' | 'udp', extPort: 8080, ip: '192.168.0.100', intPort: 80 });
  return (
    <div>
      <table className="tbl small">
        <thead>
          <tr>
            <th>Protokol</th>
            <th>Tashqi port</th>
            <th>Ichki IP</th>
            <th>Ichki port</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {device.cfg.portForwards.map((x, i) => (
            <tr key={i}>
              <td>{x.proto}</td>
              <td>{x.extPort}</td>
              <td>{x.ip}</td>
              <td>{x.intPort}</td>
              <td>
                <button onClick={() => (device.cfg.portForwards.splice(i, 1), device.applyConfig(), store.emit())}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <select value={f.proto} onChange={(e) => setF({ ...f, proto: e.target.value as any })}>
          <option>tcp</option>
          <option>udp</option>
        </select>
        <input type="number" value={f.extPort} onChange={(e) => setF({ ...f, extPort: Number(e.target.value) })} style={{ width: 80 }} />
        <input value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
        <input type="number" value={f.intPort} onChange={(e) => setF({ ...f, intPort: Number(e.target.value) })} style={{ width: 80 }} />
        <button onClick={() => (device.cfg.portForwards.push({ ...f }), device.applyConfig(), store.emit())}>Qo'shish</button>
      </div>
      <p className="hint">Masalan: uydagi kamera yoki serverga internetdan kirish uchun tashqi 8080 portni ichki 192.168.0.100:80 ga yo'naltirish (static NAT/PAT).</p>
    </div>
  );
}
