// Router / Switch: CLI va GUI sozlash (GUI har bir amalni ekvivalent IOS buyruqlari bilan ko'rsatadi).
import { useState } from 'react';
import { store, useStore } from '../store';
import type { NetOsDevice } from '../../engine/devices/netos';
import type { Switch } from '../../engine/devices/switch';
import { Terminal } from '../Terminal';
import { iosSession } from '../sessions';
import { IosCli } from '../../engine/cli/ios';
import { isValidIp, isValidMask } from '../../engine/util';

export function NetOsCliTab({ device }: { device: NetOsDevice }) {
  useStore();
  if (!device.powered) return <div className="empty-note">Qurilma o'chirilgan. "Fizik" yorlig'ida quvvat tugmasini bosing.</div>;
  const sess = iosSession(device);
  return (
    <div className="cli-tab">
      <div className="cli-hint">
        IOS buyruqlar qatori (Console). Maslahat: <kbd>?</kbd> — yordam, <kbd>Tab</kbd> — to'ldirish, <kbd>↑</kbd> — tarix, <kbd>Ctrl+C</kbd> — to'xtatish, <kbd>Ctrl+Z</kbd> — end.
      </div>
      <Terminal session={sess} height="auto" />
    </div>
  );
}

/** Buyruqlarni yashirin CLI orqali bajarish */
export function runIos(dev: NetOsDevice, lines: string[]): { cmds: string[]; errors: string[] } {
  const cli = new IosCli(dev, 'con', { silent: true, skipLogin: true });
  cli.mode = 'priv';
  cli.execute('configure terminal');
  const errors: string[] = [];
  for (const l of lines) {
    cli.errors = [];
    cli.execute(l);
    if (cli.errors.length) errors.push(`${l}: ${cli.errors.filter((e) => !e.trim().startsWith('^')).join(' ')}`);
  }
  cli.execute('end');
  cli.close();
  dev.net.refresh();
  store.emit();
  return { cmds: lines, errors };
}

export function NetOsConfigTab({ device }: { device: NetOsDevice }) {
  useStore();
  const [log, setLog] = useState<string[]>([]);
  const [ifName, setIfName] = useState<string>('');
  const [hostname, setHostname] = useState(device.hostname);
  const sw = device.fabric ? (device as unknown as Switch) : null;
  const run = (lines: string[]) => {
    const r = runIos(device, lines);
    setLog((l) => [...l, ...lines.map((x) => `${device.hostname}(config)# ${x}`), ...r.errors.map((e) => `⚠ ${e}`)].slice(-200));
  };
  const ifaces = [
    ...device.ports.filter((p) => p.media !== 'console').map((p) => p.name),
    ...device.stack.interfaces.filter((i) => i.kind === 'subif' || i.kind === 'svi' || i.kind === 'loopback').map((i) => i.name),
  ];
  const cur = ifName || ifaces[0];
  if (!device.powered) return <div className="empty-note">Qurilma o'chirilgan.</div>;
  return (
    <div className="gui-config">
      <div className="gc-left">
        <section>
          <h4>Umumiy</h4>
          <div className="row">
            <label>
              Hostname
              <input value={hostname} onChange={(e) => setHostname(e.target.value)} />
            </label>
            <button onClick={() => run([`hostname ${hostname}`])}>Qo'llash</button>
          </div>
          <div className="row">
            <button onClick={() => (runIos(device, []), (device.startupConfig = device.runningConfig()), setLog((l) => [...l, `${device.hostname}# copy running-config startup-config`, '[OK]']))}>💾 Saqlash (write memory)</button>
            <button
              onClick={() => {
                device.powerSwitch = false;
                device.net.refresh();
                device.net.sim.schedule(2000, () => {
                  device.powerSwitch = true;
                  device.net.refresh();
                });
                setLog((l) => [...l, `${device.hostname}# reload`]);
              }}
            >
              ↻ Qayta yuklash (reload)
            </button>
          </div>
          <div className="hint">Eslatma: saqlanmagan (write memory) sozlamalar qayta yuklanganda yo'qoladi — haqiqiy qurilmadagidek.</div>
        </section>
        {sw && <VlanDb sw={sw} run={run} />}
        <section>
          <h4>Interfeyslar</h4>
          <select value={cur} onChange={(e) => setIfName(e.target.value)} size={8} className="if-list">
            {ifaces.map((n) => {
              const port = device.port(n);
              const l3 = device.stack.iface(n);
              const up = port ? port.operUp : l3?.up;
              return (
                <option key={n} value={n}>
                  {up ? '🟢' : '🔴'} {n} {l3?.ip ? `— ${l3.ip}` : ''}
                </option>
              );
            })}
          </select>
          <IfaceForm key={cur} device={device} name={cur} run={run} />
        </section>
      </div>
      <div className="gc-right">
        <h4>Ekvivalent IOS buyruqlari</h4>
        <pre className="ios-log">{log.join('\n') || 'GUI da qilgan har bir o\'zgarishingiz shu yerda IOS buyrug\'i sifatida ko\'rinadi.'}</pre>
      </div>
    </div>
  );
}

function VlanDb({ sw, run }: { sw: Switch; run: (l: string[]) => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  return (
    <section>
      <h4>VLAN bazasi</h4>
      <table className="tbl small">
        <thead>
          <tr>
            <th>ID</th>
            <th>Nomi</th>
            <th>Portlar</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...sw.fabric.vlans.values()]
            .filter((v) => v.id < 1002)
            .map((v) => (
              <tr key={v.id}>
                <td>{v.id}</td>
                <td>{v.name}</td>
                <td>
                  {sw.fabric.ports
                    .filter((p) => p.switchport?.operMode === 'access' && (p.switchport.accessVlan === v.id || p.switchport.voiceVlan === v.id))
                    .map((p) => p.shortName)
                    .join(', ')}
                </td>
                <td>{v.id !== 1 && <button onClick={() => run([`no vlan ${v.id}`])}>✕</button>}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="row">
        <input placeholder="VLAN ID" value={id} onChange={(e) => setId(e.target.value)} style={{ width: 80 }} />
        <input placeholder="Nomi" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={() => Number(id) > 1 && run([`vlan ${id}`, ...(name ? [`name ${name}`] : []), 'exit'])}>Qo'shish</button>
      </div>
    </section>
  );
}

function IfaceForm({ device, name, run }: { device: NetOsDevice; name: string; run: (l: string[]) => void }) {
  const port = device.port(name);
  const l3 = device.stack.iface(name) ?? device.stack.interfaces.find((i) => i.port === port && i.kind === 'physical');
  const sp = port?.switchport;
  const [ip, setIp] = useState(l3?.ip ?? '');
  const [mask, setMask] = useState(l3?.mask ?? '255.255.255.0');
  const [desc, setDesc] = useState(port?.description || l3?.description || '');
  const [mode, setMode] = useState(sp?.mode === 'trunk' ? 'trunk' : sp?.mode === 'access' ? 'access' : 'dynamic auto');
  const [vlan, setVlan] = useState(String(sp?.accessVlan ?? 1));
  const [voice, setVoice] = useState(sp?.voiceVlan ? String(sp.voiceVlan) : '');
  const [native, setNative] = useState(String(sp?.nativeVlan ?? 1));
  const adminUp = port && l3?.kind !== 'subif' ? port.adminUp : l3?.adminUp ?? true;
  const pre = [`interface ${name}`];
  return (
    <div className="if-form">
      <div className="row">
        <label className="chk">
          <input type="checkbox" checked={adminUp} onChange={(e) => run([...pre, e.target.checked ? 'no shutdown' : 'shutdown'])} /> Port yoqilgan (no shutdown)
        </label>
      </div>
      <div className="row">
        <label>
          Tavsif
          <input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        <button onClick={() => run([...pre, desc ? `description ${desc}` : 'no description'])}>OK</button>
      </div>
      {l3 && (
        <div className="row">
          <label>
            IP manzil
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.1" />
          </label>
          <label>
            Maska
            <input value={mask} onChange={(e) => setMask(e.target.value)} />
          </label>
          <button disabled={!isValidIp(ip) || !isValidMask(mask)} onClick={() => run([...pre, `ip address ${ip} ${mask}`])}>
            Qo'llash
          </button>
        </div>
      )}
      {sp && (
        <>
          <div className="row">
            <label>
              Rejim
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="access">access</option>
                <option value="trunk">trunk</option>
                <option value="dynamic auto">dynamic auto</option>
                <option value="dynamic desirable">dynamic desirable</option>
              </select>
            </label>
            {mode === 'access' ? (
              <>
                <label>
                  Access VLAN
                  <input value={vlan} onChange={(e) => setVlan(e.target.value)} style={{ width: 70 }} />
                </label>
                <label>
                  Voice VLAN
                  <input value={voice} onChange={(e) => setVoice(e.target.value)} style={{ width: 70 }} placeholder="—" />
                </label>
              </>
            ) : mode === 'trunk' ? (
              <label>
                Native VLAN
                <input value={native} onChange={(e) => setNative(e.target.value)} style={{ width: 70 }} />
              </label>
            ) : null}
            <button
              onClick={() =>
                run([
                  ...pre,
                  `switchport mode ${mode}`,
                  ...(mode === 'access' ? [`switchport access vlan ${vlan}`, voice ? `switchport voice vlan ${voice}` : 'no switchport voice vlan'] : []),
                  ...(mode === 'trunk' ? [`switchport trunk native vlan ${native}`] : []),
                ])
              }
            >
              Qo'llash
            </button>
          </div>
          <div className="row">
            <label className="chk">
              <input type="checkbox" checked={sp.portfast} onChange={(e) => run([...pre, e.target.checked ? 'spanning-tree portfast' : 'no spanning-tree portfast'])} /> PortFast
            </label>
            <label className="chk">
              <input type="checkbox" checked={sp.portSecurity.enabled} onChange={(e) => run([...pre, ...(e.target.checked ? ['switchport mode access', 'switchport port-security', 'switchport port-security mac-address sticky'] : ['no switchport port-security'])])} /> Port-security
            </label>
          </div>
        </>
      )}
      {port?.errDisabled && (
        <div className="bad">
          Port err-disabled ({port.errDisabled}). Tiklash: <button onClick={() => run([...pre, 'shutdown', 'no shutdown'])}>shutdown / no shutdown</button>
        </div>
      )}
    </div>
  );
}
