// "show ..." buyruqlari — Cisco IOS chiqish formatiga maksimal yaqin.
import type { IosCli } from './ios';
import { CommandSet, tokenize } from './parser';
import type { Router } from '../devices/router';
import { isRouter, isSwitch } from '../devices/kinds';
import type { Switch } from '../devices/switch';
import type { NetOsDevice } from '../devices/netos';
import type { Port } from '../port';
import { shortIfName, expandIfName } from '../port';
import type { L3Interface } from '../l3';
import type { Route } from '../ipstack';
import { aclEntryText } from '../protocols/acl';
import { formatUptime, formatVlanList, ipToInt, macCisco, maskToPrefix, padRight, classfulMask, networkOf, parseVlanList } from '../util';
import { stpCostForSpeed } from '../protocols/stp';

export const SHOW_HELP: Record<string, string> = {
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  version: 'System hardware and software status',
  interfaces: 'Interface status and configuration',
  vlan: 'VTP VLAN status',
  'mac-address-table': 'MAC forwarding table',
  'spanning-tree': 'Spanning tree topology',
  cdp: 'CDP information',
  arp: 'ARP table',
  'access-lists': 'List access lists',
  clock: 'Display the system clock',
  history: 'Display the session command history',
  users: 'Display information about terminal lines',
  flash: 'display information about flash: file system',
  ephone: 'Show all IP phones',
  power: 'Power information',
  'port-security': 'Show secure port information',
  processes: 'Active process statistics',
  brief: 'Brief summary',
  route: 'IP routing table',
  dhcp: 'Show items in the DHCP database',
  binding: 'DHCP address bindings',
  nat: 'IP NAT information',
  translations: 'Translation entries',
  ospf: 'OSPF information',
  neighbor: 'Neighbor list',
  protocols: 'IP routing protocol process parameters and statistics',
  trunk: 'Show interface trunk information',
  status: 'Show interface line status',
  neighbors: 'CDP neighbor entries',
  detail: 'Show detailed information',
  hosts: 'IP domain-name, lookup style, nameservers, and host table',
  ssh: 'Information on SSH',
  logging: 'Show the contents of logging buffers',
};

type ShowFn = (cli: IosCli, a: any) => string[] | void;

const S = new CommandSet<{ cli: IosCli; out: string[] }>();
const add = (pattern: string, fn: ShowFn, privOnly = false) =>
  S.add(privOnly ? 'priv' : ['user', 'priv'], pattern, (ctx, a) => {
    const r = fn(ctx.cli, a);
    if (r) ctx.out.push(...r);
  });

export function showCommand(cli: IosCli, rest: string) {
  const words = tokenize(rest);
  // "| include X", "| begin X"
  let filter: ((l: string) => boolean) | null = null;
  const pipe = words.indexOf('|');
  let cmdWords = words;
  if (pipe >= 0) {
    cmdWords = words.slice(0, pipe);
    const [kind, ...pat] = words.slice(pipe + 1);
    const re = pat.join(' ');
    if (kind?.startsWith('i')) filter = (l) => l.includes(re);
    else if (kind?.startsWith('e')) filter = (l) => !l.includes(re);
    else if (kind?.startsWith('b')) {
      let started = false;
      filter = (l) => (started ||= l.includes(re));
    } else if (kind?.startsWith('s')) {
      let started = false;
      filter = (l) => {
        if (/^\S/.test(l)) started = l.includes(re);
        return started;
      };
    }
  }
  const mode = cli.mode === 'user' ? 'user' : 'priv';
  const res = S.parse(mode, cmdWords);
  if (!res.ok) {
    if (res.error === 'incomplete') cli.err('% Incomplete command.');
    else if (res.error === 'ambiguous') cli.err(`% Ambiguous command:  "show ${res.word}"`);
    else {
      const pos = (res as any).pos ?? 0;
      const col = cli.prompt().length + 'show '.length + cmdWords.slice(0, pos).join(' ').length + (pos ? 1 : 0);
      cli.err(' '.repeat(Math.max(0, col)) + '^');
      cli.err("% Invalid input detected at '^' marker.");
    }
    cli.print('');
    return;
  }
  const out: string[] = [];
  res.cmd.run({ cli, out }, res.args);
  for (const l of out.join('\n').split('\n')) if (!filter || filter(l)) cli.print(l);
}

export function showComplete(rest: string): string | null {
  return S.complete('priv', rest);
}

export function showHelp(cli: IosCli, rest: string): string[] {
  return S.help(cli.mode === 'user' ? 'user' : 'priv', rest, (w) => SHOW_HELP[w] ?? '');
}

// ---------------------------------------------------------------------- yordamchilar

function sw(cli: IosCli): Switch | null {
  return isSwitch(cli.dev) ? cli.dev : null;
}

function method(i: L3Interface) {
  if (i.dhcp) return 'DHCP  ';
  return i.ip ? 'manual' : 'unset ';
}

function ifStatus(port: Port | null, l3?: L3Interface): [string, string] {
  if (port) {
    const st = port.statusText;
    if (st === 'err-disabled') return ['down', 'down (err-disabled)'];
    if (l3 && l3.kind === 'subif') {
      if (!l3.adminUp) return ['administratively down', 'down'];
      return port.operUp ? ['up', 'up'] : [port.adminUp ? 'down' : 'administratively down', 'down'];
    }
    return [st, port.operUp ? 'up' : 'down'];
  }
  if (!l3) return ['down', 'down'];
  if (!l3.adminUp) return ['administratively down', 'down'];
  const up = l3.lineUp();
  return [up || l3.kind === 'svi' ? 'up' : 'down', up ? 'up' : 'down'];
}

function portType(p: Port) {
  if (p.media === 'fiber') return '1000BaseSX SFP';
  return p.speeds.includes(1000) ? '10/100/1000BaseTX' : '10/100BaseTX';
}

function hwName(p: Port) {
  if (p.name.startsWith('Gigabit')) return p.device.kind === 'router' ? 'CN Gigabit Ethernet' : 'Gigabit Ethernet';
  return 'Fast Ethernet';
}

function uptimeHms(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------- konfiguratsiya

add('running-config', (cli) => {
  const txt = cli.dev.runningConfig();
  return ['Building configuration...', '', `Current configuration : ${txt.length} bytes`, ...txt.split('\n')];
}, true);
add('running-config interface <if:iface>', (cli, a) => {
  const txt = cli.dev.runningConfig().split('\n');
  const start = txt.findIndex((l) => l === `interface ${a.if}`);
  if (start < 0) return ['% Invalid interface'];
  const out = ['Building configuration...', '', 'Current configuration : 100 bytes', '!'];
  for (let i = start; i < txt.length && txt[i] !== '!'; i++) out.push(txt[i]);
  out.push('end');
  return out;
}, true);
add('startup-config', (cli) => {
  const s = cli.dev.startupConfig;
  if (!s) return ['startup-config is not present'];
  return [`Using ${s.length} bytes`, ...s.split('\n')];
}, true);

add('version', (cli) => {
  const d = cli.dev;
  const isR = isRouter(d);
  const m = isR ? (d as Router).modelInfo : null;
  const s = sw(cli);
  const lines = [
    `${d.iosVersion}, RELEASE SOFTWARE (fc1)`,
    'Technical Support: http://www.cisco.com/techsupport',
    'Copyright (c) 1986-2019 by Cisco Systems, Inc.',
    'Compiled Thu 27-Oct-16 16:04 by prod_rel_team',
    '',
    'ROM: System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)',
    '',
    `${d.hostname} uptime is ${formatUptime(d.uptimeMs)}`,
    'System returned to ROM by power-on',
    `System image file is "flash:${d.iosImage}"`,
    '',
  ];
  if (isR) {
    lines.push(`Cisco ${d.platform} (revision 1.0) with ${m!.ramMb * 960}K/${m!.ramMb * 64}K bytes of memory.`);
    lines.push('Processor board ID FTX152400KS');
    const gi = d.ports.filter((p) => p.name.startsWith('Gigabit')).length;
    const fa = d.ports.filter((p) => p.name.startsWith('Fast')).length;
    if (gi) lines.push(`${gi} Gigabit Ethernet interfaces`);
    if (fa) lines.push(`${fa} FastEthernet interfaces`);
    lines.push('DRAM configuration is 64 bits wide with parity disabled.', '255K bytes of non-volatile configuration memory.', `${m!.flashMb * 1000}K bytes of ATA System CompactFlash 0 (Read/Write)`);
  } else if (s) {
    lines.push(`cisco ${s.platform} (PowerPC405) processor (revision B0) with 65536K bytes of memory.`, 'Processor board ID FOC1010X104');
    const fa = d.ports.filter((p) => p.name.startsWith('Fast')).length;
    const gi = d.ports.filter((p) => p.name.startsWith('Gigabit')).length;
    lines.push('Last reset from power-on', '1 Virtual Ethernet interface');
    if (fa) lines.push(`${fa} FastEthernet interfaces`);
    if (gi) lines.push(`${gi} Gigabit Ethernet interfaces`);
    lines.push('The password-recovery mechanism is enabled.', '', '64K bytes of flash-simulated non-volatile configuration memory.', `Base ethernet MAC Address       : ${d.baseMac.toUpperCase()}`, `Model number                    : ${s.platform}`, '', 'Switch Ports Model              SW Version            SW Image', '------ ----- -----              ----------            ----------', `*    1 ${String(d.ports.length - 1).padEnd(5)} ${s.platform.padEnd(18)} 15.0(2)SE4            ${s.platform.includes('3560') ? 'C3560-IPSERVICESK9-M' : 'C2960-LANBASEK9-M'}`);
  }
  lines.push('', `Configuration register is ${d.configRegister}`);
  return lines;
});

// ---------------------------------------------------------------------- interfeyslar

add('ip interface brief', (cli) => {
  const d = cli.dev;
  const lines = ['Interface              IP-Address      OK? Method Status                Protocol '];
  const rows: [string, L3Interface | undefined, Port | null][] = [];
  for (const p of d.ports) {
    if (p.media === 'console') continue;
    const l3 = d.stack.interfaces.find((i) => i.kind === 'physical' && i.port === p);
    rows.push([p.name, l3, p]);
    for (const s of d.stack.interfaces.filter((i) => i.kind === 'subif' && i.port === p)) rows.push([s.name, s, p]);
  }
  for (const i of d.stack.interfaces.filter((x) => x.kind === 'svi' || x.kind === 'loopback')) rows.push([i.name, i, null]);
  for (const [name, l3, port] of rows) {
    const [st, proto] = ifStatus(port, l3);
    const ip = l3?.ip ?? 'unassigned';
    lines.push(`${padRight(name, 23)}${padRight(ip, 16)}YES ${l3 ? method(l3) : 'unset '} ${padRight(st, 22)}${proto}`);
  }
  return lines;
});

add('ip interface [<if:iface>]', (cli, a) => {
  const d = cli.dev;
  const out: string[] = [];
  for (const i of d.stack.interfaces) {
    if (a.if && i.name !== a.if) continue;
    const [st, proto] = ifStatus(i.port && i.kind !== 'svi' ? i.port : null, i);
    out.push(`${i.name} is ${st}, line protocol is ${proto}`);
    if (i.hasIp) out.push(`  Internet address is ${i.ip}/${i.prefix}`, '  Broadcast address is 255.255.255.255', `  MTU is ${i.mtu} bytes`);
    else out.push('  Internet protocol processing disabled');
    if (i.helpers.length) out.push(`  Helper addresses are ${i.helpers.join(' ')}`);
    else out.push('  Helper address is not set');
    out.push(`  Outgoing access list is ${i.aclOut ?? 'not set'}`, `  Inbound  access list is ${i.aclIn ?? 'not set'}`, `  Proxy ARP is ${d.stack.proxyArp ? 'enabled' : 'disabled'}`);
    if (i.natRole) out.push(`  IP NAT ${i.natRole}`);
  }
  return out;
});

function interfaceDetail(cli: IosCli, p: Port | null, l3: L3Interface | undefined): string[] {
  const d = cli.dev;
  const name = l3?.name ?? p!.name;
  const [st, proto] = ifStatus(l3?.kind === 'svi' || l3?.kind === 'loopback' ? null : p, l3);
  const out = [`${name} is ${st}, line protocol is ${proto}${p?.operUp && p.switchport ? ' (connected)' : ''}`];
  const mac = macCisco(l3?.mac ?? p!.mac);
  if (l3?.kind === 'loopback') out.push('  Hardware is Loopback');
  else if (l3?.kind === 'svi') out.push(`  Hardware is EtherSVI, address is ${mac} (bia ${mac})`);
  else out.push(`  Hardware is ${hwName(p!)}, address is ${mac} (bia ${mac})`);
  if (p?.description || l3?.description) out.push(`  Description: ${l3?.description || p?.description}`);
  if (l3?.hasIp) out.push(`  Internet address is ${l3.ip}/${l3.prefix}`);
  const bw = l3?.bandwidthKbps ?? (p ? p.maxSpeed * 1000 : 1000000);
  out.push(`  MTU 1500 bytes, BW ${p?.operUp ? p.operSpeed * 1000 : bw} Kbit/sec, DLY ${p && p.maxSpeed >= 1000 ? 10 : 100} usec,`);
  const load = p && p.operSpeed ? Math.max(1, Math.round(((p.rateOut / (p.operSpeed * 1e6)) * 255))) : 1;
  const rload = p && p.operSpeed ? Math.max(1, Math.round(((p.rateIn / (p.operSpeed * 1e6)) * 255))) : 1;
  out.push(`     reliability 255/255, txload ${load}/255, rxload ${rload}/255`);
  if (l3?.kind === 'subif') out.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${l3.encapVlan ?? 1}`);
  else out.push('  Encapsulation ARPA, loopback not set');
  if (p && l3?.kind !== 'subif') {
    out.push('  Keepalive set (10 sec)');
    if (p.operUp) out.push(`  Full-duplex, ${p.operSpeed}Mb/s, media type is ${p.media === 'fiber' ? 'SFP-LC' : 'RJ45'}`);
    else out.push(`  Auto-duplex, Auto-speed, media type is ${p.media === 'fiber' ? 'SFP-LC' : 'RJ45'}`);
    out.push('  output flow-control is unsupported, input flow-control is unsupported');
    out.push('  ARP type: ARPA, ARP Timeout 04:00:00');
    const c = p.counters;
    out.push(
      `  Last input ${uptimeHms(d.now - p.lastActivity < 0 ? 0 : Math.min(d.now - p.lastActivity, 86400000))}, output ${uptimeHms(Math.min(d.now - p.lastActivity, 86400000))}, output hang never`,
      '  Last clearing of "show interface" counters never',
      `  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: ${c.outDrops}`,
      `  Queueing strategy: ${d.qosEnabled ? 'Class-based queueing' : 'fifo'}`,
      `  Output queue: ${p.queueDepth}/${p.queueLimit} (size/max)`,
      `  5 minute input rate ${Math.round(p.rateIn)} bits/sec, ${Math.round(p.rateIn / 8 / 500)} packets/sec`,
      `  5 minute output rate ${Math.round(p.rateOut)} bits/sec, ${Math.round(p.rateOut / 8 / 500)} packets/sec`,
      `     ${c.rxFrames} packets input, ${c.rxBytes} bytes, 0 no buffer`,
      `     Received ${c.rxBroadcast} broadcasts (0 IP multicasts)`,
      `     0 runts, 0 giants, 0 throttles`,
      `     ${c.inErrors} input errors, ${c.crc} CRC, 0 frame, 0 overrun, 0 ignored, 0 abort`,
      '     0 watchdog, 0 multicast, 0 pause input',
      `     ${c.txFrames} packets output, ${c.txBytes} bytes, 0 underruns`,
      `     0 output errors, ${c.collisions} collisions, 1 interface resets`,
      '     0 unknown protocol drops',
      '     0 babbles, 0 late collision, 0 deferred',
      '     0 lost carrier, 0 no carrier',
      '     0 output buffer failures, 0 output buffers swapped out',
    );
  } else if (l3) {
    out.push(`     ${l3.counters.inPkts} packets input, ${l3.counters.inBytes} bytes`, `     ${l3.counters.outPkts} packets output, ${l3.counters.outBytes} bytes`);
  }
  return out;
}

add('interfaces', (cli) => {
  const d = cli.dev;
  const out: string[] = [];
  for (const p of d.ports) {
    if (p.media === 'console') continue;
    out.push(...interfaceDetail(cli, p, d.stack.interfaces.find((i) => i.kind === 'physical' && i.port === p)));
    for (const s of d.stack.interfaces.filter((i) => i.kind === 'subif' && i.port === p)) out.push(...interfaceDetail(cli, p, s));
  }
  for (const i of d.stack.interfaces.filter((x) => x.kind === 'svi' || x.kind === 'loopback')) out.push(...interfaceDetail(cli, null, i));
  return out;
});
add('interfaces <if:iface>', (cli, a) => {
  const t = cli.resolveInterface(a.if, false);
  if (typeof t === 'string') return ['                ^', "% Invalid input detected at '^' marker."];
  return interfaceDetail(cli, t.port ?? null, t.l3);
});

add('interfaces status', (cli) => {
  const d = cli.dev;
  const s = sw(cli);
  const lines = ['', 'Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const p of d.ports) {
    if (p.media === 'console') continue;
    const status = p.errDisabled ? 'err-disabled' : !p.adminUp ? 'disabled' : p.operUp ? 'connected' : 'notconnect';
    const vlan = !p.switchport ? 'routed' : p.switchport.operMode === 'trunk' ? 'trunk' : String(p.switchport.accessVlan);
    const duplex = p.operUp ? 'a-full' : 'auto';
    const speed = p.operUp ? `a-${p.operSpeed}` : 'auto';
    lines.push(`${padRight(p.shortName, 10)}${padRight(p.description.slice(0, 18), 19)}${padRight(status, 13)}${padRight(vlan, 11)}${duplex.padStart(6)} ${speed.padStart(6)} ${portType(p)}`);
  }
  if (!s) return lines;
  return lines;
});

add('interfaces trunk', (cli) => {
  const s = sw(cli);
  if (!s) return [];
  const f = s.fabric;
  const trunks = f.ports.filter((p) => p.switchport?.operMode === 'trunk' && p.operUp);
  if (!trunks.length) return [];
  const mode = (p: Port) => (p.switchport!.mode === 'trunk' ? 'on' : p.switchport!.mode === 'dynamic desirable' ? 'desirable' : 'auto');
  const out = ['', 'Port        Mode         Encapsulation  Status        Native vlan'];
  for (const p of trunks) out.push(`${padRight(p.shortName, 12)}${padRight(mode(p), 13)}${padRight('802.1q', 15)}${padRight('trunking', 14)}${p.switchport!.nativeVlan}`);
  out.push('', 'Port        Vlans allowed on trunk');
  for (const p of trunks) out.push(`${padRight(p.shortName, 12)}${p.switchport!.allowedVlans === 'all' ? '1-4094' : formatVlanList(p.switchport!.allowedVlans)}`);
  out.push('', 'Port        Vlans allowed and active in management domain');
  for (const p of trunks) out.push(`${padRight(p.shortName, 12)}${formatVlanList(f.portVlans(p))}`);
  out.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  for (const p of trunks) out.push(`${padRight(p.shortName, 12)}${formatVlanList(f.portVlans(p).filter((v) => f.stp.canForward(p, v)))}`);
  return out;
});

add('interfaces switchport', (cli) => {
  const s = sw(cli);
  if (!s) return [];
  const out: string[] = [];
  for (const p of s.fabric.ports) {
    const sp = p.switchport;
    if (!sp) continue;
    out.push(
      `Name: ${p.shortName}`,
      'Switchport: Enabled',
      `Administrative Mode: ${sp.mode === 'access' ? 'static access' : sp.mode === 'trunk' ? 'trunk' : sp.mode}`,
      `Operational Mode: ${p.operUp ? (sp.operMode === 'access' ? 'static access' : 'trunk') : 'down'}`,
      'Administrative Trunking Encapsulation: dot1q',
      `Negotiation of Trunking: ${sp.nonegotiate || sp.mode === 'access' ? 'Off' : 'On'}`,
      `Access Mode VLAN: ${sp.accessVlan} (${s.fabric.vlans.get(sp.accessVlan)?.name ?? 'Inactive'})`,
      `Trunking Native Mode VLAN: ${sp.nativeVlan} (${s.fabric.vlans.get(sp.nativeVlan)?.name ?? 'Inactive'})`,
      `Voice VLAN: ${sp.voiceVlan ?? 'none'}`,
      `Trunking VLANs Enabled: ${sp.allowedVlans === 'all' ? 'All' : formatVlanList(sp.allowedVlans)}`,
      'Protected: false',
      '',
    );
  }
  return out;
});

add('interfaces description', (cli) => {
  const d = cli.dev;
  const out = ['Interface                      Status         Protocol Description'];
  for (const p of d.ports) {
    if (p.media === 'console') continue;
    const [st, pr] = ifStatus(p);
    out.push(`${padRight(p.shortName, 31)}${padRight(st === 'administratively down' ? 'admin down' : st, 15)}${padRight(pr, 9)}${p.description}`);
  }
  return out;
});

// ---------------------------------------------------------------------- marshrutlash

function routeLine(r: Route, now: number, w = 9): string {
  const via = r.nextHop ? `via ${r.nextHop}` : '';
  const code = r.code === 'O*E2' ? 'O*E2' : r.code;
  const pfx = `${r.network}/${r.prefix}`;
  const c = code.padEnd(w);
  if (r.code === 'C' || r.code === 'L') return `${c}${pfx} is directly connected, ${r.iface!.name}`;
  if (r.code === 'S' || r.code === 'S*') {
    if (!r.nextHop && r.iface) return `${c}${pfx} is directly connected, ${r.iface.name}`;
    return `${c}${pfx} [${r.ad}/${r.metric}] ${via}${r.iface ? ', ' + r.iface.name : ''}`;
  }
  return `${c}${pfx} [${r.ad}/${r.metric}] ${via}, 00:00:${String(Math.floor(now / 1000) % 60).padStart(2, '0')}, ${r.iface?.name ?? ''}`;
}

function routeTable(cli: IosCli, filter?: (r: Route) => boolean): string[] {
  const d = cli.dev;
  if (!d.stack.opts.ipRouting) {
    const gw = d.stack.defaultGateway;
    return [gw ? `Default gateway is ${gw}` : 'Default gateway is not set', '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty'];
  }
  const routes = d.stack.routes().filter((r) => !filter || filter(r));
  const out = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
    '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
    '       * - candidate default, U - per-user static route, o - ODR',
    '       P - periodic downloaded static route',
    '',
  ];
  const def = d.stack.routes().find((r) => r.prefix === 0);
  out.push(def ? `Gateway of last resort is ${def.nextHop ?? '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  // Klassli tarmoqlar bo'yicha guruhlash (IOS 15 formati)
  const groups = new Map<string, Route[]>();
  const direct: Route[] = [];
  for (const r of routes) {
    const cm = classfulMask(r.network);
    const cp = maskToPrefix(cm);
    if (r.prefix >= cp) {
      const key = `${networkOf(r.network, cm)}/${cp}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    } else direct.push(r);
  }
  const entries: { key: number; lines: string[] }[] = [];
  for (const r of direct) entries.push({ key: ipToInt(r.network) - 0.5, lines: [routeLine(r, d.now, 6)] });
  for (const [k, g] of groups) {
    const [net, cp] = k.split('/');
    if (g.length === 1 && g[0].prefix === Number(cp)) {
      entries.push({ key: ipToInt(net), lines: [routeLine(g[0], d.now, 6)] });
      continue;
    }
    const masks = new Set(g.map((r) => r.prefix));
    const head = masks.size > 1 ? `      ${net}/${cp} is variably subnetted, ${g.length} subnets, ${masks.size} masks` : `      ${net}/${[...masks][0]} is subnetted, ${g.length} subnets`;
    entries.push({ key: ipToInt(net), lines: [head, ...g.sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefix - b.prefix).map((r) => routeLine(r, d.now, 9))] });
  }
  entries.sort((a, b) => a.key - b.key);
  for (const e of entries) out.push(...e.lines);
  return out;
}

add('ip route', (cli) => routeTable(cli));
add('ip route {src:static|connected|ospf}', (cli, a) => routeTable(cli, (r) => (a.src === 'static' ? r.code.startsWith('S') : a.src === 'connected' ? r.code === 'C' || r.code === 'L' : r.code.startsWith('O'))));
add('ip route <ip:ip>', (cli, a) => {
  const r = cli.dev.stack.lookup(a.ip);
  if (!r) return ['% Network not in table'];
  return [`Routing entry for ${r.route.network}/${r.route.prefix}`, `  Known via "${r.route.code.startsWith('O') ? 'ospf 1' : r.route.code.startsWith('S') ? 'static' : 'connected'}", distance ${r.route.ad}, metric ${r.route.metric}`, '  Routing Descriptor Blocks:', `  * ${r.route.nextHop ?? 'directly connected'}, via ${r.iface.name}`];
});

add('ip protocols', (cli) => {
  const o = cli.dev.ospf;
  if (!o) return [];
  const out = [
    `Routing Protocol is "ospf ${o.processId}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Router ID ${o.routerId}`,
    '  Number of areas in this router is 1. 1 normal 0 stub 0 nssa',
    '  Maximum path: 4',
    '  Routing for Networks:',
    ...o.networks.map((n) => `    ${n.network} ${n.wildcard} area ${n.area}`),
  ];
  if (o.passive.size) out.push('  Passive Interface(s):', ...[...o.passive].map((p) => `    ${p}`));
  out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
  for (const n of o.neighbors.values()) out.push(`    ${padRight(n.routerId, 16)}     110      00:00:${String(Math.floor((cli.dev.now - n.since) / 1000) % 60).padStart(2, '0')}`);
  out.push('  Distance: (default is 110)');
  return out;
});

add('ip ospf neighbor', (cli) => cli.dev.ospf?.neighborTable() ?? []);
add('ip ospf database', (cli) => cli.dev.ospf?.databaseText() ?? []);
add('ip ospf', (cli) => {
  const o = cli.dev.ospf;
  if (!o) return ['%OSPF: No router process'];
  return [` Routing Process "ospf ${o.processId}" with ID ${o.routerId}`, ' Supports only single TOS(TOS0) routes', ` SPF algorithm executed ${o.spfRuns} times`, ` Number of areas in this router is 1. 1 normal 0 stub 0 nssa`, ` Reference bandwidth unit is ${o.referenceBw} mbps`];
});

add('arp|ip arp', (cli) => {
  const d = cli.dev;
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const rows: string[] = [];
  for (const i of d.stack.interfaces) if (i.hasIp && i.up) rows.push(`Internet  ${padRight(i.ip!, 17)}${padRight('-', 11)}${padRight(macCisco(i.mac), 16)}ARPA   ${i.name}`);
  for (const [ip, e] of d.stack.arp) {
    if (e.expires < d.now && e.type === 'dynamic') continue;
    const age = e.type === 'static' ? '-' : String(Math.floor((d.now - e.created) / 60000));
    rows.push(`Internet  ${padRight(ip, 17)}${padRight(age, 11)}${padRight(macCisco(e.mac), 16)}ARPA   ${e.iface.name}`);
  }
  rows.sort((a, b) => ipToInt(a.split(/\s+/)[1]) - ipToInt(b.split(/\s+/)[1]));
  return [...out, ...rows];
});

// ---------------------------------------------------------------------- L2

add('mac address-table|mac-address-table [dynamic|static]', (cli, a) => macTable(cli, (e) => (a['dynamic|static'] ? e.type.toLowerCase() === a['dynamic|static'] : true)));
add('mac address-table|mac-address-table interface <if:iface>', (cli, a) => macTable(cli, (e) => e.port !== 'CPU' && e.port.name === a.if));
add('mac address-table|mac-address-table vlan <v:num:1-4094>', (cli, a) => macTable(cli, (e) => e.vlan === a.v));
add('mac address-table|mac-address-table count', (cli) => {
  const s = sw(cli);
  if (!s) return [];
  const dyn = [...s.fabric.macTable.values()].filter((e) => e.type === 'DYNAMIC').length;
  return ['', 'Mac Entries for all vlans :', '---------------------------', `Dynamic Address Count  : ${dyn}`, `Static  Address Count  : ${s.fabric.macTable.size - dyn}`, `Total Mac Addresses    : ${s.fabric.macTable.size}`, '', `Total Mac Address Space Available: ${s.fabric.maxMacEntries - s.fabric.macTable.size}`];
});

function macTable(cli: IosCli, f: (e: import('../switching').MacEntry) => boolean): string[] {
  const s = sw(cli);
  if (!s) return ["% Invalid input detected at '^' marker."];
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  const rows = [...s.fabric.macTable.values()].filter(f).filter((e) => e.port !== 'CPU' || true).sort((a, b) => a.vlan - b.vlan || (a.mac < b.mac ? -1 : 1));
  let n = 0;
  for (const e of rows) {
    if (e.port === 'CPU') continue;
    n++;
    out.push(`${String(e.vlan).padStart(4)}    ${padRight(macCisco(e.mac), 18)}${padRight(e.type, 12)}${e.port.shortName}`);
  }
  out.push(`Total Mac Addresses for this criterion: ${n}`);
  return out;
}

add('vlan [brief]', (cli, a) => {
  const s = sw(cli);
  if (!s) return ["% Invalid input detected at '^' marker."];
  const f = s.fabric;
  const out = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  for (const v of [...f.vlans.values()].sort((x, y) => x.id - y.id)) {
    const ports = f.ports.filter((p) => p.switchport && p.switchport.operMode === 'access' && (p.switchport.accessVlan === v.id || p.switchport.voiceVlan === v.id)).map((p) => p.shortName);
    const status = v.id >= 1002 ? 'act/unsup' : v.status === 'suspended' ? 'suspended' : 'active';
    const chunks: string[] = [];
    for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
    out.push(`${padRight(String(v.id), 5)}${padRight(v.name, 33)}${padRight(status, 10)}${chunks[0] ?? ''}`);
    for (const c of chunks.slice(1)) out.push(' '.repeat(48) + c);
  }
  if (!a.brief) {
    out.push('', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2', '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------');
    for (const v of [...f.vlans.values()].sort((x, y) => x.id - y.id)) out.push(`${padRight(String(v.id), 5)}${padRight(v.id === 1002 ? 'fddi' : v.id === 1003 ? 'tr' : v.id === 1004 ? 'fdnet' : v.id === 1005 ? 'trnet' : 'enet', 6)}${padRight(String(100000 + v.id), 11)}1500  -      -      -        -    -        0      0`);
  }
  return out;
});
add('vlan id <v:num:1-4094>', (cli, a) => {
  const s = sw(cli);
  const v = s?.fabric.vlans.get(a.v);
  if (!v) return [`VLAN id ${a.v} not found in current VLAN database`];
  const ports = s!.fabric.ports.filter((p) => s!.fabric.portCarriesVlan(p, a.v)).map((p) => p.shortName);
  return ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------', `${padRight(String(v.id), 5)}${padRight(v.name, 33)}${padRight(v.status, 10)}${ports.join(', ')}`];
});

add('spanning-tree [vlan] [<v:num:1-4094>]', (cli, a) => {
  const s = sw(cli);
  if (!s) return ["% Invalid input detected at '^' marker."];
  const stp = s.fabric.stp;
  if (!stp.enabled) return ['No spanning tree instance exists.'];
  const out: string[] = [];
  const insts = [...stp.instances.values()].filter((i) => (a.v ? i.vlan === a.v : true)).sort((x, y) => x.vlan - y.vlan);
  if (!insts.length) return [a.v ? `Spanning tree instance(s) for vlan ${a.v} does not exist.` : 'No spanning tree instance exists.'];
  for (const inst of insts) {
    const members = [...inst.ports.entries()].filter(([p, i]) => i.role !== 'disabled' && p.operUp);
    if (!members.length && !a.v) continue;
    out.push(`VLAN${String(inst.vlan).padStart(4, '0')}`);
    out.push(`  Spanning tree enabled protocol ${stp.mode === 'rapid-pvst' ? 'rstp' : 'ieee'}`);
    out.push(`  Root ID    Priority    ${inst.rootPrio}`);
    out.push(`             Address     ${macCisco(inst.rootMac)}`);
    if (inst.isRoot) out.push('             This bridge is the root');
    else {
      out.push(`             Cost        ${inst.rootCost}`);
      out.push(`             Port        ${s.fabric.ports.indexOf(inst.rootPort!) + 1}(${inst.rootPort!.name})`);
    }
    out.push(`             Hello Time  ${stp.helloTime} sec  Max Age ${stp.maxAge} sec  Forward Delay ${stp.forwardDelay} sec`, '');
    out.push(`  Bridge ID  Priority    ${inst.bridgePrio}  (priority ${inst.priority} sys-id-ext ${inst.vlan})`);
    out.push(`             Address     ${macCisco(inst.bridgeMac)}`);
    out.push(`             Hello Time  ${stp.helloTime} sec  Max Age ${stp.maxAge} sec  Forward Delay ${stp.forwardDelay} sec`);
    out.push('             Aging Time  20', '');
    out.push('Interface        Role Sts Cost      Prio.Nbr Type', '---------------- ---- --- --------- -------- --------------------------------');
    const role: Record<string, string> = { root: 'Root', designated: 'Desg', alternate: 'Altn', backup: 'Back', disabled: 'Disb' };
    const sts: Record<string, string> = { forwarding: 'FWD', blocking: stp.mode === 'rapid-pvst' ? 'BLK' : 'BLK', listening: 'LIS', learning: 'LRN', disabled: 'DIS' };
    for (const [p, i] of members.sort((x, y) => s.fabric.ports.indexOf(x[0]) - s.fabric.ports.indexOf(y[0]))) {
      const pid = inst.portId(p);
      out.push(`${padRight(p.shortName, 17)}${role[i.role]} ${sts[i.state]} ${padRight(String(inst.portCost(p)), 10)}${padRight(`${pid >> 8}.${pid & 0xff}`, 9)}P2p${i.edge ? ' Edge' : ''}`);
    }
    out.push('');
  }
  return out;
});
add('spanning-tree summary', (cli) => {
  const s = sw(cli);
  if (!s) return [];
  const stp = s.fabric.stp;
  const roots = [...stp.instances.values()].filter((i) => i.isRoot).map((i) => `VLAN${String(i.vlan).padStart(4, '0')}`);
  return [`Switch is in ${stp.mode} mode`, `Root bridge for: ${roots.join(', ') || 'none'}`, `Extended system ID           is enabled`, `Portfast Default             is ${stp.portfastDefault ? 'enabled' : 'disabled'}`, `PortFast BPDU Guard Default  is ${stp.bpduGuardDefault ? 'enabled' : 'disabled'}`];
});

add('cdp neighbors', (cli) => cli.dev.cdp.table());
add('cdp neighbors detail', (cli) => cli.dev.cdp.detail());
add('cdp', (cli) => (cli.dev.ios.cdpRun ? ['Global CDP information:', `        Sending CDP packets every ${cli.dev.cdp.timer} seconds`, `        Sending a holdtime value of ${cli.dev.cdp.holdtime} seconds`, '        Sending CDPv2 advertisements is  enabled'] : ['% CDP is not enabled']));

add('dtp', () => ['Global DTP information', '        Sending DTP Hello packets every 30 seconds', '        Dynamic Trunk timeout is 300 seconds']);

add('port-security', (cli) => {
  const s = sw(cli);
  if (!s) return [];
  const out = ['Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action', '                (Count)       (Count)          (Count)', '---------------------------------------------------------------------------'];
  for (const p of s.fabric.ports) {
    const ps = p.switchport?.portSecurity;
    if (!ps?.enabled) continue;
    out.push(`${p.shortName.padStart(11)}${String(ps.maximum).padStart(15)}${String(ps.secureMacs.length).padStart(13)}${String(ps.violations).padStart(19)}${ps.violation.replace(/^./, (c) => c.toUpperCase()).padStart(17)}`);
  }
  out.push('---------------------------------------------------------------------------', 'Total Addresses in System (excluding one mac per port)     : 0', 'Max Addresses limit in System (excluding one mac per port) : 1024');
  return out;
});
add('port-security interface <if:iface>', (cli, a) => {
  const s = sw(cli);
  const p = s?.port(a.if);
  if (!p?.switchport) return [];
  const ps = p.switchport.portSecurity;
  const last = ps.secureMacs[ps.secureMacs.length - 1];
  return [
    `Port Security              : ${ps.enabled ? 'Enabled' : 'Disabled'}`,
    `Port Status                : ${p.errDisabled ? 'Secure-shutdown' : ps.enabled && p.operUp ? 'Secure-up' : 'Secure-down'}`,
    `Violation Mode             : ${ps.violation.replace(/^./, (c) => c.toUpperCase())}`,
    'Aging Time                 : 0 mins',
    'Aging Type                 : Absolute',
    'SecureStatic Address Aging : Disabled',
    `Maximum MAC Addresses      : ${ps.maximum}`,
    `Total MAC Addresses        : ${ps.secureMacs.length}`,
    'Configured MAC Addresses   : 0',
    `Sticky MAC Addresses       : ${ps.sticky ? ps.secureMacs.length : 0}`,
    `Last Source Address:Vlan   : ${last ? macCisco(last) + ':' + p.switchport.accessVlan : '0000.0000.0000:0'}`,
    `Security Violation Count   : ${ps.violations}`,
  ];
});

add('power inline', (cli) => {
  const d = cli.dev;
  if (d.poeBudgetW <= 0) return ["% Invalid input detected at '^' marker."];
  const pse = d.ports.filter((p) => p.poeMaxW > 0);
  const used = pse.reduce((s, p) => s + p.poeDrawW, 0);
  const out = [`Available:${d.poeBudgetW.toFixed(1)}(w)  Used:${used.toFixed(1)}(w)  Remaining:${(d.poeBudgetW - used).toFixed(1)}(w)`, '', 'Interface Admin  Oper       Power   Device              Class Max', '                           (Watts)                            ', '--------- ------ ---------- ------- ------------------- ----- ----'];
  for (const p of pse) {
    const dev = p.poeDrawW > 0 ? p.peer?.device : null;
    out.push(`${padRight(p.shortName, 10)}${padRight(p.poeEnabled ? 'auto' : 'off', 7)}${padRight(p.poeDrawW > 0 ? 'on' : 'off', 11)}${padRight(p.poeDrawW.toFixed(1), 8)}${padRight(dev ? dev.model : 'n/a', 20)}${padRight(dev ? (p.poeDrawW <= 6.49 ? '1' : p.poeDrawW <= 15.4 ? '3' : '4') : 'n/a', 6)}${p.poeMaxW.toFixed(1)}`);
  }
  return out;
});

// ---------------------------------------------------------------------- xizmatlar

add('ip dhcp binding', (cli) => {
  const out = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address'];
  for (const b of cli.dev.dhcpServer.bindings.values()) {
    if (b.state !== 'bound') continue;
    out.push(`${padRight(b.ip, 17)}${padRight(macCisco(b.mac).toUpperCase(), 24)}${padRight('--', 24)}Automatic`);
  }
  return out;
});
add('ip dhcp pool [<name:word>]', (cli, a) => {
  const out: string[] = [];
  for (const p of cli.dev.dhcpServer.pools) {
    if (a.name && p.name !== a.name) continue;
    const leased = [...cli.dev.dhcpServer.bindings.values()].filter((b) => b.pool === p.name && b.state === 'bound').length;
    const total = p.mask ? 2 ** (32 - maskToPrefix(p.mask)) - 2 : 0;
    out.push('', `Pool ${p.name} :`, ' Utilization mark (high/low)    : 100 / 0', ' Subnet size (first/next)       : 0 / 0 ', ` Total addresses                : ${total}`, ` Leased addresses               : ${leased}`, ' Excluded addresses             : ' + cli.dev.dhcpServer.excluded.length, ' Pending event                  : none', '', ' 1 subnet is currently in the pool', ' Current index        IP address range                    Leased/Excluded/Total', `   ${p.network}  ${p.network} - ${p.network}   ${leased}    / 0     / ${total}`);
  }
  return out;
});
add('ip dhcp conflict', (cli) => ['IP address        Detection method   Detection time          VRF', ...cli.dev.dhcpServer.conflicts.map((ip) => `${padRight(ip, 18)}Gratuitous ARP     Mar 01 1993 12:00 AM`)]);
add('ip dhcp server statistics', (cli) => {
  const s = cli.dev.dhcpServer.stats;
  return ['Memory usage         23841', `Address pools        ${cli.dev.dhcpServer.pools.length}`, `Automatic bindings   ${cli.dev.dhcpServer.bindings.size}`, '', 'Message              Received', `DHCPDISCOVER         ${s.discovers}`, `DHCPREQUEST          ${s.requests}`, `DHCPRELEASE          ${s.releases}`, '', 'Message              Sent', `DHCPOFFER            ${s.offers}`, `DHCPACK              ${s.acks}`, `DHCPNAK              ${s.naks}`];
});
add('ip nat translations [verbose]', (cli) => cli.dev.stack.nat.table());
add('ip nat statistics', (cli) => {
  const n = cli.dev.stack.nat;
  const d = cli.dev;
  return [
    `Total translations: ${n.entries.length + n.statics.length} (${n.statics.length} static, ${n.entries.length} dynamic, ${n.entries.filter((e) => e.proto !== 'ip').length} extended)`,
    `Outside Interfaces: ${d.stack.interfaces.filter((i) => i.natRole === 'outside').map((i) => i.name).join(', ')}`,
    `Inside Interfaces: ${d.stack.interfaces.filter((i) => i.natRole === 'inside').map((i) => i.name).join(', ')}`,
    `Hits: ${n.stats.hits}  Misses: ${n.stats.misses}`,
    'Expired translations: 0',
    'Dynamic mappings:',
    ...n.rules.map((r) => `-- Inside Source\naccess-list ${r.acl} ${r.iface ? 'interface ' + r.iface : 'pool ' + r.pool} refCount ${n.entries.length}`),
  ];
});
add('access-lists|ip access-lists [<name:word>]', (cli, a) => {
  const out: string[] = [];
  for (const acl of cli.dev.stack.acls.acls.values()) {
    if (a.name && acl.name !== a.name) continue;
    out.push(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`);
    for (const e of acl.entries) out.push(`    ${e.seq} ${aclEntryText(e)}${e.matches ? ` (${e.matches} match(es))` : ''}`);
  }
  return out;
});

add('ephone [registered]', (cli, a) => {
  const r = isRouter(cli.dev) ? (cli.dev as Router) : null;
  if (!r || !r.cme.enabled) return ["% Invalid input detected at '^' marker."];
  const lines = r.cme.ephoneText();
  if (a.registered) return lines.filter((_, i, arr) => true);
  return lines;
});
add('telephony-service', (cli) => {
  const r = isRouter(cli.dev) ? (cli.dev as Router) : null;
  if (!r?.cme.enabled) return [];
  const c = r.cme;
  return ['CONFIG (Version=4.1(0))', '=====================', 'Version 4.1(0)', 'Cisco Unified Communications Manager Express', `ip source-address ${c.sourceIp ?? '0.0.0.0'} port ${c.port}`, `max-ephones ${c.maxEphones}`, `max-dn ${c.maxDn}`, `auto assign ${c.autoAssign ? `${c.autoAssign.from} to ${c.autoAssign.to}` : 'disabled'}`, `registered ephones: ${[...c.ephones.values()].filter((e) => e.registered).length}`];
});
add('ephone-dn [summary]', (cli) => {
  const r = isRouter(cli.dev) ? (cli.dev as Router) : null;
  if (!r?.cme.enabled) return [];
  const out = ['PORT    CH   NAME                  STATE      FEATURE   NUMBER'];
  for (const dn of r.cme.dns.values()) out.push(`${padRight(String(dn.tag), 8)}1    ${padRight(dn.name ?? '', 22)}${padRight('IDLE', 11)}          ${dn.number}`);
  return out;
});

// ---------------------------------------------------------------------- tizim

add('clock [detail]', (cli) => {
  const base = Date.UTC(1993, 2, 1, 0, 0, 0) + cli.dev.now;
  const d = new Date(base);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return [`*${d.toISOString().slice(11, 23)} UTC ${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`];
});
add('history', (cli) => cli.history.map((h) => `  ${h}`));
add('users', (cli) => {
  const out = ['    Line       User       Host(s)              Idle       Location'];
  let n = 0;
  for (const s of cli.dev.sessions) out.push(`${n++ === 0 ? '*' : ' '}  ${s.line === 'con' ? '0 con 0' : `${388 + n} vty ${n - 1}`}${' '.repeat(5)}${padRight(s.user, 11)}idle                 00:00:00 ${s.line === 'vty' ? s.from : ''}`);
  return out;
});
add('flash|flash:', (cli) => [`System flash directory:`, 'File  Length   Name/status', `  1   ${isRouter(cli.dev) ? '33591768' : '4414921'}  ${cli.dev.iosImage}`, `[${isRouter(cli.dev) ? '33591768' : '4414921'} bytes used, 30424472 available, 64016240 total]`, '63488K bytes of processor board System flash (Read/Write)']);
add('ip ssh', (cli) => {
  const ios = cli.dev.ios;
  if (!ios.rsaBits) return ['SSH Disabled - version 1.99', '%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).'];
  return [`SSH Enabled - version ${ios.sshVersion === 2 ? '2.0' : '1.99'}`, 'Authentication timeout: 120 secs; Authentication retries: 3'];
});
add('hosts', (cli) => {
  const ios = cli.dev.ios;
  const out = [`Default domain is ${ios.domainName || 'not set'}`, `Name/address lookup uses ${ios.domainLookup ? 'domain service' : 'static mappings'}`, `Name servers are ${ios.nameServers.join(', ') || '255.255.255.255'}`, '', 'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate', '       temp - temporary, perm - permanent', '       NA - Not Applicable None - Not defined', '', 'Host                      Port  Flags      Age Type   Address(es)'];
  for (const [n, ip] of ios.ipHosts) out.push(`${padRight(n, 26)}None  (perm, OK)  0   IP      ${ip}`);
  return out;
});
add('processes [cpu]', (cli) => {
  const d = cli.dev;
  const busy = Math.min(99, Math.round(d.ports.reduce((s, p) => s + p.rateIn + p.rateOut, 0) / 2e6));
  return [`CPU utilization for five seconds: ${busy + 1}%/${Math.round(busy / 2)}%; one minute: ${busy + 1}%; five minutes: ${busy + 1}%`, ' PID Runtime(ms)   Invoked      uSecs   5Sec   1Min   5Min TTY Process', '   1          12        45        266  0.00%  0.00%  0.00%   0 Chunk Manager', '  54         120       334        359  0.00%  0.01%  0.00%   0 IP Input', '  70          44       220        200  0.00%  0.00%  0.00%   0 CDP Protocol', '  88          18        90        200  0.00%  0.00%  0.00%   0 ARP Input'];
});
add('logging', (cli) => ['Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)', '', '    Console logging: level debugging', `    Buffer logging:  level debugging, ${cli.dev.consoleHistory.length} messages logged`, `    Trap logging: level informational, ${cli.dev.ios.loggingHosts.length} message lines logged`, ...cli.dev.ios.loggingHosts.map((h) => `        Logging to ${h}  (udp port 514)`), '', 'Log Buffer (4096 bytes):', ...cli.dev.consoleHistory.slice(-40)]);
add('controllers', () => ['Interface GigabitEthernet0/0', 'Hardware is PQ3_TSEC']);
add('environment', (cli) => [`FAN is OK`, `TEMPERATURE is OK`, `POWER is ${cli.dev.poweredViaPoe ? 'PoE' : 'AC'} OK`]);
add('inventory', (cli) => [`NAME: "${cli.dev.hostname} chassis", DESCR: "${cli.dev.platform} chassis"`, `PID: ${cli.dev.platform}      , VID: V01 , SN: FTX152400KS`]);
add('stp', () => ['% Did you mean "show spanning-tree"?']);

export { stpCostForSpeed, parseVlanList, expandIfName, shortIfName };
