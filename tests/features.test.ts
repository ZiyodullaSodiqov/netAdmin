import { describe, it, expect } from 'vitest';
import { Network } from '../src/engine/network';
import { Router } from '../src/engine/devices/router';
import { Switch } from '../src/engine/devices/switch';
import { Host } from '../src/engine/devices/host';
import { IosCli } from '../src/engine/cli/ios';
import { HostShell, openConsole } from '../src/engine/cli/hostshell';
import { pingOnce } from '../src/engine/cli/apps';
import { httpFetch } from '../src/engine/devices/host-apps';
import type { Cable } from '../src/engine/link';

function ios(dev: any, lines: string[]) {
  const c = new IosCli(dev, 'con', { skipLogin: true });
  let out = '';
  c.onOutput((t) => (out += t));
  c.mode = 'priv';
  for (const l of lines) c.input(l);
  return { c, out: () => out };
}

function ping(net: Network, h: any, dst: string, tries = 3): string {
  let res = 'none';
  for (let i = 0; i < tries && res !== 'reply'; i++) {
    pingOnce(h, h.stack, dst, { ident: 5000 + Math.floor(Math.random() * 50000), seq: 1, size: 32, timeoutMs: 2000 }, (r) => (res = r.kind));
    net.sim.runFor(2100);
  }
  return res;
}

function pc(net: Network, name: string, x: number, ip?: string, gw?: string) {
  const h = net.addDevice(new Host('pc', name), x, 10);
  if (ip) {
    h.gateway = gw ?? '';
    h.setNicConfig(h.nics[0], { mode: 'static', ip, mask: '255.255.255.0' });
  }
  return h;
}

describe('Kabel qoidalari', () => {
  it("Cat6 100 m dan uzun bo'lsa link ishlamaydi", () => {
    const net = new Network();
    const sw = net.addDevice(new Switch('2960-24TT', 'SW'), 0, 0);
    const a = pc(net, 'A', 5);
    const c = net.connect(a.port('FastEthernet0')!, sw.port('fa0/1')!) as Cable;
    expect(a.port('FastEthernet0')!.operUp).toBe(true);
    c.manualLengthM = 130;
    net.refresh();
    expect(a.port('FastEthernet0')!.operUp).toBe(false);
    expect(c.check().reason).toContain('100');
  });

  it("Auto-MDIX yo'q: PC ↔ Router 1841 uchun kross kabel kerak", () => {
    const net = new Network();
    const r = net.addDevice(new Router('1841', 'R'), 0, 0);
    const a = pc(net, 'A', 5);
    ios(r, ['conf t', 'int fa0/0', 'no shut', 'end']);
    const c = net.connect(a.port('FastEthernet0')!, r.port('fa0/0')!, 'copper-straight') as Cable;
    expect(c.check().ok).toBe(false);
    expect(r.port('fa0/0')!.operUp).toBe(false);
    net.disconnect(c);
    const c2 = net.connect(a.port('FastEthernet0')!, r.port('fa0/0')!, 'copper-cross') as Cable;
    expect(c2.check().ok).toBe(true);
    expect(r.port('fa0/0')!.operUp).toBe(true);
  });

  it("optik kabel RJ45 portga kirmaydi", () => {
    const net = new Network();
    const sw = net.addDevice(new Switch('2960-24TT', 'SW'), 0, 0);
    const a = pc(net, 'A', 5);
    const r = net.connect(a.port('FastEthernet0')!, sw.port('fa0/1')!, 'fiber-mm');
    expect(typeof r).toBe('string');
  });
});

describe('Xavfsizlik', () => {
  it('port-security: begona MAC portni err-disabled qiladi', () => {
    const net = new Network();
    const sw = net.addDevice(new Switch('2960-24TT', 'SW'), 0, 0);
    const a = pc(net, 'A', 5, '10.0.0.1');
    const b = pc(net, 'B', 10, '10.0.0.2');
    net.connect(a.port('FastEthernet0')!, sw.port('fa0/1')!);
    net.connect(b.port('FastEthernet0')!, sw.port('fa0/2')!);
    const x = ios(sw, ['conf t', 'int range fa0/1-2', 'switchport mode access', 'spanning-tree portfast', 'int fa0/1', 'switchport port-security', 'switchport port-security mac-address sticky', 'end']);
    expect(x.c.errors).toEqual([]);
    net.sim.runFor(1000);
    expect(ping(net, a, '10.0.0.2')).toBe('reply');
    // hujumchi: boshqa kompyuterni shu portga ulash
    const evil = pc(net, 'Evil', 15, '10.0.0.66');
    net.disconnect(net.cables.find((c) => c.a.device === a || c.b.device === a)!);
    net.connect(evil.port('FastEthernet0')!, sw.port('fa0/1')!);
    net.sim.runFor(500);
    ping(net, evil, '10.0.0.2', 1);
    expect(sw.port('fa0/1')!.errDisabled).toBe('psecure-violation');
    const sh = ios(sw, ['show port-security', 'show interfaces status', 'show running-config']);
    expect(sh.out()).toContain('err-disabled');
    expect(sh.out()).toContain('switchport port-security mac-address sticky');
  });

  it('kengaytirilgan ACL ping ni bloklaydi, HTTP ga ruxsat beradi', () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R'), 0, 0);
    const a = pc(net, 'A', -10, '10.1.0.10', '10.1.0.1');
    const srv = net.addDevice(new Host('server', 'S'), 10, 10);
    srv.gateway = '10.2.0.1';
    srv.setNicConfig(srv.nics[0], { mode: 'static', ip: '10.2.0.10', mask: '255.255.255.0' });
    net.connect(a.port('FastEthernet0')!, r.port('g0/0')!);
    net.connect(srv.port('GigabitEthernet0')!, r.port('g0/1')!);
    ios(r, [
      'conf t',
      'int g0/0',
      'ip add 10.1.0.1 255.255.255.0',
      'no shut',
      'int g0/1',
      'ip add 10.2.0.1 255.255.255.0',
      'no shut',
      'exit',
      'access-list 100 deny icmp any host 10.2.0.10 echo',
      'access-list 100 permit ip any any',
      'int g0/0',
      'ip access-group 100 in',
      'end',
    ]);
    net.sim.runFor(1000);
    expect(ping(net, a, '10.2.0.10')).toBe('unreachable');
    let http: any = null;
    httpFetch(a, 'http://10.2.0.10/', (x) => (http = x));
    net.sim.runFor(5000);
    expect(http?.ok).toBe(true);
    const sh = ios(r, ['show access-lists']);
    expect(sh.out()).toMatch(/deny icmp any host 10\.2\.0\.10 echo \(\d+ match/);
  });

  it("telnet: vty paroli bo'lmasa ulanish rad etiladi, parol bilan ishlaydi", () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R'), 0, 0);
    const a = pc(net, 'A', 5, '10.0.0.10', '10.0.0.1');
    net.connect(a.port('FastEthernet0')!, r.port('g0/0')!);
    ios(r, ['conf t', 'int g0/0', 'ip add 10.0.0.1 255.255.255.0', 'no shut', 'end']);
    net.sim.runFor(500);
    const sh = new HostShell(a);
    let out = '';
    sh.onOutput((t) => (out += t));
    sh.input('telnet 10.0.0.1');
    net.sim.runFor(3000);
    expect(out).toContain('Password required, but none set');
    ios(r, ['conf t', 'line vty 0 4', 'password sirli', 'login', 'exit', 'enable secret class', 'end']);
    out = '';
    sh.input('telnet 10.0.0.1');
    net.sim.runFor(2000);
    sh.input('sirli');
    net.sim.runFor(1000);
    sh.input('enable');
    net.sim.runFor(500);
    sh.input('class');
    net.sim.runFor(500);
    sh.input('show running-config | include hostname');
    net.sim.runFor(1000);
    expect(out).toContain('User Access Verification');
    expect(out).toContain('Router#');
    expect(out).toContain('hostname Router');
  });
});

describe('Marshrutlash va xizmatlar', () => {
  it('L3 switch: SVI lar orasida marshrutlash (ip routing)', () => {
    const net = new Network();
    const mls = net.addDevice(new Switch('3560-24PS', 'MLS'), 0, 0);
    const a = pc(net, 'A', -5, '192.168.10.10', '192.168.10.1');
    const b = pc(net, 'B', 5, '192.168.20.10', '192.168.20.1');
    net.connect(a.port('FastEthernet0')!, mls.port('fa0/1')!);
    net.connect(b.port('FastEthernet0')!, mls.port('fa0/2')!);
    const x = ios(mls, [
      'conf t',
      'ip routing',
      'vlan 10',
      'vlan 20',
      'int fa0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'int fa0/2',
      'switchport mode access',
      'switchport access vlan 20',
      'spanning-tree portfast',
      'int vlan 10',
      'ip address 192.168.10.1 255.255.255.0',
      'no shut',
      'int vlan 20',
      'ip address 192.168.20.1 255.255.255.0',
      'no shut',
      'end',
    ]);
    expect(x.c.errors).toEqual([]);
    net.sim.runFor(2000);
    expect(ping(net, a, '192.168.20.10')).toBe('reply');
    const sh = ios(mls, ['show ip route']);
    expect(sh.out()).toContain('Vlan20');
  });

  it('DHCP relay (ip helper-address) orqali markaziy serverdan IP olish', () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R'), 0, 0);
    const srv = net.addDevice(new Host('server', 'DHCP-Srv'), 10, 10);
    const a = pc(net, 'A', -10);
    net.connect(a.port('FastEthernet0')!, r.port('g0/0')!);
    net.connect(srv.port('GigabitEthernet0')!, r.port('g0/1')!);
    ios(r, ['conf t', 'int g0/0', 'ip add 192.168.50.1 255.255.255.0', 'ip helper-address 10.9.9.10', 'no shut', 'int g0/1', 'ip add 10.9.9.1 255.255.255.0', 'no shut', 'end']);
    srv.gateway = '10.9.9.1';
    srv.setNicConfig(srv.nics[0], { mode: 'static', ip: '10.9.9.10', mask: '255.255.255.0' });
    srv.dhcpServiceEnabled = true;
    srv.dhcpService.pools = [{ name: 'LAN50', network: '192.168.50.0', mask: '255.255.255.0', startIp: '192.168.50.100', maxUsers: 50, defaultRouter: '192.168.50.1', dns: ['10.9.9.10'], leaseSec: 86400 }];
    a.setNicConfig(a.nics[0], { mode: 'dhcp' });
    net.sim.runFor(20_000);
    expect(a.nics[0].iface.ip).toBe('192.168.50.100');
    expect(a.stack.defaultGateway).toBe('192.168.50.1');
  });

  it("konsol kabeli: PC Terminal orqali router CLI", () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R'), 0, 0);
    const a = pc(net, 'Admin', 5);
    const c = net.connect(a.port('RS232')!, r.port('Console')!);
    expect(typeof c).not.toBe('string');
    const s = openConsole(a);
    expect(typeof s).not.toBe('string');
    let out = '';
    (s as any).onOutput((t: string) => (out += t));
    (s as any).input('enable');
    (s as any).input('show version');
    expect(out).toContain('Router#');
    expect(out).toContain('Configuration register is 0x2102');
  });

  it("saqlanmagan konfiguratsiya qayta yuklashda yo'qoladi", () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R'), 0, 0);
    ios(r, ['conf t', 'hostname Toshkent', 'end']);
    expect(r.hostname).toBe('Toshkent');
    r.powerSwitch = false;
    net.refresh();
    r.powerSwitch = true;
    net.refresh();
    expect(r.hostname).toBe('Router');
    ios(r, ['conf t', 'hostname Samarqand', 'end', 'write memory']);
    r.powerSwitch = false;
    net.refresh();
    r.powerSwitch = true;
    net.refresh();
    expect(r.hostname).toBe('Samarqand');
  });

  it('PoE budjeti va PoE siz switchda telefon yoqilmaydi', async () => {
    const { IpPhone } = await import('../src/engine/devices/ipphone');
    const net = new Network();
    const sw = net.addDevice(new Switch('2960-24TT', 'SW'), 0, 0);
    const swp = net.addDevice(new Switch('2960-24PS', 'SWP'), 20, 0);
    const p1 = net.addDevice(new IpPhone('P1'), 0, 10);
    const p2 = net.addDevice(new IpPhone('P2'), 20, 10);
    net.connect(p1.port('Switch')!, sw.port('fa0/1')!);
    net.connect(p2.port('Switch')!, swp.port('fa0/1')!);
    expect(p1.powered).toBe(false);
    expect(p2.powered).toBe(true);
    const sh = ios(swp, ['show power inline']);
    expect(sh.out()).toMatch(/Fa0\/1\s+auto\s+on\s+6\.3/);
    ios(swp, ['conf t', 'int fa0/1', 'power inline never', 'end']);
    expect(p2.powered).toBe(false);
  });
});
