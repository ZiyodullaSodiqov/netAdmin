import { describe, it, expect } from 'vitest';
import { Network } from '../src/engine/network';
import { Router } from '../src/engine/devices/router';
import { Switch } from '../src/engine/devices/switch';
import { Host } from '../src/engine/devices/host';
import { IosCli } from '../src/engine/cli/ios';
import { pingOnce } from '../src/engine/cli/apps';

function cli(dev: any, lines: string[]) {
  const c = new IosCli(dev, 'con', { skipLogin: true });
  let out = '';
  c.onOutput((t) => (out += t));
  c.mode = 'priv';
  for (const l of lines) c.input(l);
  return { c, out: () => out };
}

function ping(net: Network, h: Host, dst: string, timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    pingOnce(h, h.stack, dst, { ident: Math.floor(Math.random() * 60000), seq: 1, size: 32, timeoutMs: timeout }, (r) => resolve(r.kind));
    net.sim.runFor(timeout + 100);
  });
}

describe('asosiy L2/L3', () => {
  it('ikki PC bir switchda ping qiladi', async () => {
    const net = new Network();
    const sw = net.addDevice(new Switch('2960-24TT', 'SW1'), 0, 0);
    const a = net.addDevice(new Host('pc', 'PC1'), -5, 5);
    const b = net.addDevice(new Host('pc', 'PC2'), 5, 5);
    expect(typeof net.connect(a.port('FastEthernet0')!, sw.port('Fa0/1')!)).not.toBe('string');
    expect(typeof net.connect(b.port('FastEthernet0')!, sw.port('Fa0/2')!)).not.toBe('string');
    a.setNicConfig(a.nics[0], { mode: 'static', ip: '192.168.1.10', mask: '255.255.255.0' });
    b.setNicConfig(b.nics[0], { mode: 'static', ip: '192.168.1.11', mask: '255.255.255.0' });
    // STP: listening+learning = 30 s
    net.sim.runFor(31_000);
    expect(await ping(net, a, '192.168.1.11')).toBe('reply');
    expect(sw.fabric.macTable.size).toBeGreaterThanOrEqual(2);
  });

  it('router-on-a-stick: VLAN lar orasida marshrutlash + DHCP', async () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R1'), 0, -10);
    const sw = net.addDevice(new Switch('2960-24TT', 'SW1'), 0, 0);
    const a = net.addDevice(new Host('pc', 'PC-A'), -5, 5);
    const b = net.addDevice(new Host('pc', 'PC-B'), 5, 5);
    net.connect(r.port('g0/0')!, sw.port('g0/1')!);
    net.connect(a.port('FastEthernet0')!, sw.port('Fa0/1')!);
    net.connect(b.port('FastEthernet0')!, sw.port('Fa0/2')!);
    const s = cli(sw, [
      'conf t',
      'vlan 10',
      'name SALES',
      'vlan 20',
      'name HR',
      'int fa0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'int fa0/2',
      'sw mo acc',
      'sw acc vl 20',
      'spanning-tree portfast',
      'int g0/1',
      'switchport mode trunk',
      'end',
    ]);
    expect(s.c.errors).toEqual([]);
    const rr = cli(r, [
      'conf t',
      'int g0/0',
      'no shut',
      'int g0/0.10',
      'encapsulation dot1Q 10',
      'ip address 192.168.10.1 255.255.255.0',
      'int g0/0.20',
      'encapsulation dot1Q 20',
      'ip address 192.168.20.1 255.255.255.0',
      'exit',
      'ip dhcp excluded-address 192.168.10.1 192.168.10.9',
      'ip dhcp pool V10',
      'network 192.168.10.0 255.255.255.0',
      'default-router 192.168.10.1',
      'ip dhcp pool V20',
      'network 192.168.20.0 255.255.255.0',
      'default-router 192.168.20.1',
      'end',
    ]);
    expect(rr.c.errors).toEqual([]);
    a.setNicConfig(a.nics[0], { mode: 'dhcp' });
    b.setNicConfig(b.nics[0], { mode: 'dhcp' });
    net.sim.runFor(45_000);
    expect(a.nics[0].iface.ip).toBe('192.168.10.10');
    expect(b.nics[0].iface.ip).toBe('192.168.20.2');
    expect(a.stack.defaultGateway).toBe('192.168.10.1');
    // Cisco: birinchi paket router ARP ni hal qilguncha tashlanadi (".!!!!")
    expect(await ping(net, a, b.nics[0].iface.ip!)).toBe('timeout');
    expect(await ping(net, a, b.nics[0].iface.ip!)).toBe('reply');
    // show buyruqlari xatosiz ishlaydi
    const sh = cli(r, ['show ip interface brief', 'show ip route', 'show ip dhcp binding', 'show running-config']);
    expect(sh.out()).toContain('GigabitEthernet0/0.10');
    expect(sh.out()).toContain('C        192.168.10.0/24 is directly connected, GigabitEthernet0/0.10');
    const shs = cli(sw, ['show vlan brief', 'show interfaces trunk', 'show mac address-table', 'show spanning-tree']);
    expect(shs.out()).toContain('SALES');
    expect(shs.out()).toContain('trunking');
  });

  it('IOS qisqartmalar va xatolar', () => {
    const net = new Network();
    const r = net.addDevice(new Router('2911', 'R1'), 0, 0);
    const x = cli(r, ['sh ip int br', 'conf t', 'hostnam R1', 'int g0/9', 'end', 'foo bar']);
    expect(x.out()).toContain('Interface              IP-Address');
    expect(r.hostname).toBe('R1');
    expect(x.out()).toContain('% Invalid');
    const y = cli(r, ['s']);
    expect(y.out()).toContain('Ambiguous');
  });
});
