import { describe, it, expect } from 'vitest';
import { buildScenario } from '../src/engine/scenarios';
import type { Host } from '../src/engine/devices/host';
import type { IpPhone } from '../src/engine/devices/ipphone';
import type { Switch } from '../src/engine/devices/switch';
import type { Router } from '../src/engine/devices/router';
import { pingOnce } from '../src/engine/cli/apps';
import { httpFetch, LoadGenerator } from '../src/engine/devices/host-apps';
import { saveTopology, loadTopology } from '../src/engine/factory';
import { IosCli } from '../src/engine/cli/ios';
import { HostShell } from '../src/engine/cli/hostshell';

function pingRes(net: any, h: any, dst: string): string {
  let res = 'none';
  pingOnce(h, h.stack, dst, { ident: 7777 + Math.floor(Math.random() * 1000), seq: 1, size: 32, timeoutMs: 3000 }, (r) => (res = r.kind));
  net.sim.runFor(3100);
  return res;
}

/** Har bir Cisco router ARP hal qilinguncha birinchi paketni tashlaydi — bir necha marta urinamiz */
function ping2(net: any, h: any, dst: string) {
  let a = 'none';
  for (let i = 0; i < 4 && a !== 'reply'; i++) a = pingRes(net, h, dst);
  return a;
}

describe('Ofis laboratoriyasi', () => {
  const net = buildScenario('office');
  net.sim.runFor(70_000);
  const pc1 = net.device('PC1') as Host;
  const lap = net.device('Laptop1') as Host;
  const mob = net.device('Smartfon1') as Host;
  const ph1 = net.device('Phone1') as IpPhone;
  const ph2 = net.device('Phone2') as IpPhone;
  const r1 = net.device('R1-Ofis') as Router;

  it('telefonlar PoE dan quvvat oladi va Voice VLAN ni CDP dan o\'rganadi', () => {
    expect(ph1.powered).toBe(true);
    expect(ph1.poweredViaPoe).toBe(true);
    expect(ph1.voiceVlan).toBe(20);
    expect(ph1.cpu.ip?.startsWith('192.168.20.')).toBe(true);
  });

  it("telefonlar CME da ro'yxatdan o'tadi", () => {
    expect(ph1.state).toBe('registered');
    expect(ph2.state).toBe('registered');
    expect(ph1.primaryDn).toMatch(/^100[123]$/);
  });

  it("telefon orqali qo'ng'iroq va RTP", () => {
    ph1.dial(ph2.primaryDn);
    net.sim.runFor(500);
    expect(ph2.callState).toBe('ringing');
    ph2.answer();
    net.sim.runFor(5000);
    expect(ph1.callState).toBe('connected');
    expect(ph2.voice.received).toBeGreaterThan(200);
    expect(ph2.voice.mos).toBeGreaterThan(4.0);
    ph1.hangup();
    net.sim.runFor(500);
    expect(ph2.callState).toBe('idle');
  });

  it('telefon ortidagi PC data VLAN dan IP oladi va internetga chiqadi', () => {
    expect(pc1.nics[0].iface.ip?.startsWith('192.168.10.')).toBe(true);
    expect(ping2(net, pc1, '203.0.113.10')).toBe('reply');
    expect(r1.stack.nat.entries.length).toBeGreaterThan(0);
  });

  it("Wi-Fi mijozlar AP ga ulanadi va VLAN 30 dan IP oladi", () => {
    expect(net.wifiAssociation(lap.wirelessNic!.port)).not.toBeNull();
    expect(lap.wirelessNic!.iface.ip?.startsWith('192.168.30.')).toBe(true);
    expect(mob.nics[0].iface.ip?.startsWith('192.168.30.')).toBe(true);
  });

  it('DNS + HTTP: noutbuk www.netadmin.uz sahifasini ochadi', () => {
    let res: any = null;
    httpFetch(lap, 'http://www.netadmin.uz', (r) => (res = r));
    net.sim.runFor(5000);
    expect(res?.ok).toBe(true);
    expect(res.body).toContain('Internetga xush kelibsiz');
  });

  it('show buyruqlari', () => {
    const sw = net.device('SW1') as Switch;
    const c = new IosCli(sw, 'con', { skipLogin: true });
    let out = '';
    c.onOutput((t) => (out += t));
    c.mode = 'priv';
    c.input('show power inline');
    c.input('show cdp neighbors');
    c.input('show interfaces trunk');
    expect(out).toContain('7960');
    expect(out).toContain('R1-Ofis');
    const rc = new IosCli(r1, 'con', { skipLogin: true });
    let o2 = '';
    rc.onOutput((t) => (o2 += t));
    rc.mode = 'priv';
    rc.input('show ephone');
    rc.input('show ip nat translations');
    expect(o2).toContain('REGISTERED');
    expect(o2).toContain('100.64.0.2');
  });

  it('SSH orqali routerga ulanish', () => {
    const sh = new HostShell(pc1);
    let out = '';
    sh.onOutput((t) => (out += t));
    // RSA kalit kerak
    const rc = new IosCli(r1, 'con', { skipLogin: true });
    rc.mode = 'priv';
    rc.input('conf t');
    rc.input('crypto key generate rsa modulus 1024');
    rc.input('end');
    sh.input('ssh -l admin 192.168.10.1');
    net.sim.runFor(2000);
    sh.input('admin123');
    net.sim.runFor(1000);
    sh.input('show ip interface brief');
    net.sim.runFor(1000);
    expect(out).toContain('Password:');
    expect(out).toContain('R1-Ofis#');
    expect(out).toContain('GigabitEthernet0/0.20');
  });

  it('saqlash va yuklash', () => {
    const file = saveTopology(net, 'office');
    const json = JSON.parse(JSON.stringify(file));
    const n2 = loadTopology(json);
    n2.sim.runFor(70_000);
    const p = n2.device('Phone1') as IpPhone;
    expect(p.state).toBe('registered');
    const l2 = n2.device('Laptop1') as Host;
    expect(l2.wirelessNic!.iface.ip?.startsWith('192.168.30.')).toBe(true);
  });
});

describe('Uy tarmog\'i', () => {
  it('Wi-Fi router NAT orqali internetga chiqaradi', () => {
    const net = buildScenario('home');
    net.sim.runFor(40_000);
    const lap = net.device('Noutbuk') as Host;
    const pc = net.device('PC-Uy') as Host;
    expect(lap.wirelessNic!.iface.ip?.startsWith('192.168.0.')).toBe(true);
    expect(pc.nics[0].iface.ip?.startsWith('192.168.0.')).toBe(true);
    let res: any = null;
    httpFetch(lap, 'http://maktab.uz', (r) => (res = r));
    net.sim.runFor(5000);
    expect(res?.ok).toBe(true);
  });
});

describe('OSPF', () => {
  it('qo\'shnilik, marshrutlar va qayta yaqinlashish', () => {
    const net = buildScenario('ospf');
    net.sim.runFor(35_000);
    const r1 = net.device('R1') as Router;
    expect([...r1.ospf!.neighbors.values()].filter((n) => n.state === 'FULL').length).toBe(2);
    const routes = r1.stack.routes().filter((r) => r.code === 'O');
    expect(routes.some((r) => r.network === '192.168.3.0')).toBe(true);
    const pc1 = net.device('PC1') as Host;
    expect(ping2(net, pc1, '192.168.3.10')).toBe('reply');
    // R1-R3 linkini uzish
    const r3 = net.device('R3')!;
    const cable = net.cables.find((c) => (c.a.device === r1 && c.b.device === r3) || (c.b.device === r1 && c.a.device === r3))!;
    net.disconnect(cable);
    net.sim.runFor(3000);
    const via = r1.stack.lookup('192.168.3.10');
    expect(via?.iface.name).toBe('GigabitEthernet0/1');
    expect(ping2(net, pc1, '192.168.3.10')).toBe('reply');
  });
});

describe('STP', () => {
  it('halqada bitta port bloklanadi va ping ishlaydi', () => {
    const net = buildScenario('stp');
    net.sim.runFor(35_000);
    const sws = ['SW-A', 'SW-B', 'SW-C'].map((n) => net.device(n) as Switch);
    let blocked = 0;
    for (const s of sws) for (const inst of s.fabric.stp.instances.values()) for (const i of inst.ports.values()) if (i.state === 'blocking') blocked++;
    expect(blocked).toBe(1);
    const roots = sws.filter((s) => s.fabric.stp.instances.get(1)!.isRoot);
    expect(roots.length).toBe(1);
    const p1 = net.device('PC-B') as Host;
    expect(ping2(net, p1, '10.1.1.20')).toBe('reply');
    const before = net.sim.processed;
    net.sim.runFor(10_000);
    // broadcast bo'roni yo'q — voqealar soni cheklangan
    expect(net.sim.processed - before).toBeLessThan(5000);
  });
});

describe('Server yuklamasi', () => {
  it("ko'p so'rovda CPU oshadi va latency o'sadi", () => {
    const net = buildScenario('load');
    net.sim.runFor(35_000);
    const srv = net.device('Web-Server') as Host;
    const gens: LoadGenerator[] = [];
    for (let i = 1; i <= 4; i++) {
      const pc = net.device(`Client${i}`) as Host;
      const g = new LoadGenerator(pc, 'http://10.10.10.100/api/data', 60, 300, 10);
      pc.loadGens.push(g);
      g.start();
      gens.push(g);
    }
    net.sim.runFor(8000);
    const s = srv.http.current;
    expect(s.rps).toBeGreaterThan(150);
    expect(s.cpu).toBeGreaterThan(60);
    expect(s.queue + s.active).toBeGreaterThan(4);
    expect(gens[0].stats.ok).toBeGreaterThan(100);
  });
});
