// show running-config — qurilma holatidan IOS konfiguratsiya matnini yaratish.
import type { NetOsDevice } from '../devices/netos';
import { type5, type7 } from './crypto';
import type { Router } from '../devices/router';
import { isRouter, isSwitch } from '../devices/kinds';
import type { Switch } from '../devices/switch';
import { aclEntryText } from '../protocols/acl';
import { formatVlanList, macCisco } from '../util';
import type { Port } from '../port';

export function generateRunningConfig(dev: NetOsDevice): string {
  const L: string[] = [];
  const ios = dev.ios;
  const enc = ios.servicePasswordEncryption;
  const pw = (p: string) => (enc ? `7 ${type7(p)}` : p);
  L.push('!');
  L.push(`version ${dev.iosVersion.match(/Version (\d+\.\d+)/)?.[1] ?? '15.0'}`);
  L.push('no service timestamps log datetime msec');
  L.push('no service timestamps debug datetime msec');
  L.push(enc ? 'service password-encryption' : 'no service password-encryption');
  L.push('!');
  L.push(`hostname ${dev.hostname}`);
  L.push('!');
  if (ios.enableSecret) L.push(`enable secret 5 ${ios.enableSecret}`);
  if (ios.enablePassword) L.push(`enable password ${pw(ios.enablePassword)}`);
  if (ios.enableSecret || ios.enablePassword) L.push('!');
  const d = dev.dhcpServer;
  for (const e of d.excluded) L.push(`ip dhcp excluded-address ${e.from}${e.to !== e.from ? ' ' + e.to : ''}`);
  if (d.excluded.length) L.push('!');
  for (const p of d.pools) {
    L.push(`ip dhcp pool ${p.name}`);
    if (p.network) L.push(` network ${p.network} ${p.mask}`);
    if (p.defaultRouter) L.push(` default-router ${p.defaultRouter}`);
    if (p.dns.length) L.push(` dns-server ${p.dns.join(' ')}`);
    if (p.domain) L.push(` domain-name ${p.domain}`);
    if (p.option150) L.push(` option 150 ip ${p.option150}`);
    if (p.leaseSec !== 86400) {
      const dd = Math.floor(p.leaseSec / 86400);
      const hh = Math.floor((p.leaseSec % 86400) / 3600);
      const mm = Math.floor((p.leaseSec % 3600) / 60);
      L.push(` lease ${dd} ${hh} ${mm}`);
    }
  }
  if (d.pools.length) L.push('!');
  if (dev.stack.opts.ipRouting && isSwitch(dev)) L.push('ip routing', '!');
  L.push(ios.cdpRun ? '' : 'no cdp run');
  if (!ios.domainLookup) L.push('no ip domain-lookup');
  if (ios.domainName) L.push(`ip domain-name ${ios.domainName}`);
  for (const ns of ios.nameServers) L.push(`ip name-server ${ns}`);
  for (const [n, ip] of ios.ipHosts) L.push(`ip host ${n} ${ip}`);
  if (ios.rsaBits && ios.sshVersion === 2) L.push('ip ssh version 2');
  L.push('!');
  for (const u of ios.users) {
    L.push(`username ${u.name}${u.privilege !== 1 ? ' privilege ' + u.privilege : ''} ${u.secret ? 'secret 5 ' + u.secret : 'password ' + pw(u.password ?? '')}`);
  }
  if (ios.users.length) L.push('!');
  if (dev.qosEnabled) L.push('mls qos', '!');
  if (isSwitch(dev)) {
    const f = dev.fabric;
    L.push(`spanning-tree mode ${f.stp.mode}`);
    if (f.stp.portfastDefault) L.push('spanning-tree portfast default');
    if (f.stp.bpduGuardDefault) L.push('spanning-tree portfast bpduguard default');
    for (const [v, p] of [...f.stp.priorities].sort((a, b) => a[0] - b[0])) L.push(`spanning-tree vlan ${v} priority ${p}`);
    for (const v of f.stp.disabledVlans) L.push(`no spanning-tree vlan ${v}`);
    L.push('!');
    if (f.vtpMode !== 'transparent' || f.vtpDomain) {
      if (f.vtpDomain) L.push(`vtp domain ${f.vtpDomain}`);
      L.push(`vtp mode ${f.vtpMode}`, '!');
    }
    // VLAN lar (IOS ularni vlan.dat da saqlaydi, bu yerda qulaylik uchun konfiguratsiyada)
    for (const v of [...f.vlans.values()].sort((a, b) => a.id - b.id)) {
      if (v.id === 1 || v.id >= 1002) continue;
      L.push(`vlan ${v.id}`);
      if (v.name !== `VLAN${String(v.id).padStart(4, '0')}`) L.push(` name ${v.name}`);
      if (v.status === 'suspended') L.push(' state suspend');
      L.push('!');
    }
  }
  // interfeyslar
  const ifaceBlocks = interfaceBlocks(dev);
  for (const b of ifaceBlocks) {
    L.push(...b);
    L.push('!');
  }
  if (dev.ospf) {
    const o = dev.ospf;
    L.push(`router ospf ${o.processId}`);
    if (o.routerIdConfigured) L.push(` router-id ${o.routerIdConfigured}`);
    L.push(' log-adjacency-changes');
    if (o.referenceBw !== 100) L.push(` auto-cost reference-bandwidth ${o.referenceBw}`);
    if (o.passiveDefault) L.push(' passive-interface default');
    for (const p of o.passive) L.push(` ${o.passiveDefault ? 'no ' : ''}passive-interface ${p}`);
    for (const n of o.networks) L.push(` network ${n.network} ${n.wildcard} area ${n.area}`);
    if (o.defaultOriginate) L.push(' default-information originate');
    L.push('!');
  }
  const nat = dev.stack.nat;
  for (const p of nat.pools.values()) L.push(`ip nat pool ${p.name} ${p.start} ${p.end} netmask ${p.mask}`);
  for (const r of nat.rules) L.push(`ip nat inside source list ${r.acl} ${r.iface ? 'interface ' + r.iface : 'pool ' + r.pool}${r.overload ? ' overload' : ''}`);
  for (const s of nat.statics) L.push(s.proto ? `ip nat inside source static ${s.proto} ${s.local} ${s.localPort} ${s.global} ${s.globalPort}` : `ip nat inside source static ${s.local} ${s.global}`);
  L.push('ip classless');
  if (dev.stack.defaultGateway) L.push(`ip default-gateway ${dev.stack.defaultGateway}`);
  L.push(...dev.stack.staticRouteText());
  L.push('!');
  L.push(ios.httpServer ? 'ip http server' : 'no ip http server');
  L.push('!');
  for (const a of dev.stack.acls.acls.values()) {
    const numbered = /^\d+$/.test(a.name);
    if (numbered) for (const e of a.entries) L.push(`access-list ${a.name} ${aclEntryText(e)}`);
    else {
      L.push(`ip access-list ${a.type} ${a.name}`);
      for (const e of a.entries) L.push(` ${aclEntryText(e)}`);
    }
  }
  if (dev.stack.acls.acls.size) L.push('!');
  for (const h of ios.loggingHosts) L.push(`logging ${h}`);
  if (ios.ntpServer) L.push(`ntp server ${ios.ntpServer}`);
  if (isRouter(dev) && dev.cme.enabled) {
    const cme = dev.cme;
    L.push('telephony-service');
    if (cme.maxEphones) L.push(` max-ephones ${cme.maxEphones}`);
    if (cme.maxDn) L.push(` max-dn ${cme.maxDn}`);
    if (cme.sourceIp) L.push(` ip source-address ${cme.sourceIp} port ${cme.port}`);
    if (cme.autoAssign) L.push(` auto assign ${cme.autoAssign.from} to ${cme.autoAssign.to}`);
    L.push('!');
    for (const dn of [...cme.dns.values()].sort((a, b) => a.tag - b.tag)) {
      L.push(`ephone-dn ${dn.tag}`);
      if (dn.number) L.push(` number ${dn.number}`);
      if (dn.name) L.push(` name ${dn.name}`);
      if (dn.label) L.push(` label ${dn.label}`);
      L.push('!');
    }
    for (const e of [...cme.ephones.values()].sort((a, b) => a.tag - b.tag)) {
      L.push(`ephone ${e.tag}`);
      if (e.mac) L.push(` mac-address ${macCisco(e.mac).toUpperCase()}`);
      if (e.type) L.push(` type ${e.type}`);
      if (e.buttons.length) L.push(` button ${e.buttons.map((b) => `${b.button}:${b.dnTag}`).join(',')}`);
      L.push('!');
    }
  }
  if (ios.bannerMotd) L.push(`banner motd ^C${ios.bannerMotd}^C`, '!');
  const line = (name: string, cfg: typeof ios.con, isVty: boolean) => {
    L.push(name);
    if (cfg.execTimeout !== null) L.push(` exec-timeout ${Math.floor(cfg.execTimeout / 60)} ${cfg.execTimeout % 60}`);
    if (cfg.password) L.push(` password ${pw(cfg.password)}`);
    if (cfg.loggingSync) L.push(' logging synchronous');
    if (cfg.accessClass) L.push(` access-class ${cfg.accessClass} in`);
    if (cfg.login === 'local') L.push(' login local');
    else if (cfg.login === 'line' && (cfg.password || isVty)) L.push(' login');
    if (isVty) {
      const t = cfg.transport;
      if (t.length === 1) L.push(` transport input ${t[0]}`);
      else if (t.length === 0) L.push(' transport input none');
    }
  };
  L.push('!');
  line('line con 0', ios.con, false);
  L.push('!');
  L.push('line aux 0');
  L.push('!');
  line('line vty 0 4', ios.vty, true);
  L.push('!');
  L.push('!');
  L.push('end');
  return L.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').replace(/\n\n+/g, '\n');
}

function portLines(p: Port, dev: NetOsDevice): string[] {
  const out: string[] = [];
  const sp = p.switchport;
  if (p.description) out.push(` description ${p.description}`);
  if (sp) {
    if (sp.accessVlan !== 1 && sp.mode !== 'trunk') out.push(` switchport access vlan ${sp.accessVlan}`);
    if (sp.nativeVlan !== 1) out.push(` switchport trunk native vlan ${sp.nativeVlan}`);
    if (sp.allowedVlans !== 'all') out.push(` switchport trunk allowed vlan ${formatVlanList(sp.allowedVlans)}`);
    if (sp.mode === 'access' || sp.mode === 'trunk') out.push(` switchport mode ${sp.mode}`);
    else if (sp.mode === 'dynamic desirable') out.push(' switchport mode dynamic desirable');
    if (sp.nonegotiate) out.push(' switchport nonegotiate');
    if (sp.voiceVlan !== null) out.push(` switchport voice vlan ${sp.voiceVlan}`);
    const ps = sp.portSecurity;
    if (ps.enabled) {
      out.push(' switchport port-security');
      if (ps.maximum !== 1) out.push(` switchport port-security maximum ${ps.maximum}`);
      if (ps.violation !== 'shutdown') out.push(` switchport port-security violation ${ps.violation}`);
      if (ps.sticky) {
        out.push(' switchport port-security mac-address sticky');
        for (const m of ps.secureMacs) out.push(` switchport port-security mac-address sticky ${macCisco(m).toUpperCase()}`);
      }
    }
    if (sp.portfast && !(dev as Switch).fabric?.stp.portfastDefault) out.push(' spanning-tree portfast');
    if (sp.bpduGuard) out.push(' spanning-tree bpduguard enable');
    if (sp.stpCost !== null) out.push(` spanning-tree cost ${sp.stpCost}`);
    if (sp.stpPortPriority !== 128) out.push(` spanning-tree port-priority ${sp.stpPortPriority}`);
  }
  if (p.speedSetting !== 'auto') out.push(` speed ${p.speedSetting}`);
  if (p.duplexSetting !== 'auto') out.push(` duplex ${p.duplexSetting}`);
  if (p.poeMaxW > 0 && !p.poeEnabled) out.push(' power inline never');
  if (p.qosTrust) out.push(' mls qos trust cos');
  if (dev.cdp.disabledPorts.has(p)) out.push(' no cdp enable');
  return out;
}

function interfaceBlocks(dev: NetOsDevice): string[][] {
  const blocks: string[][] = [];
  const l3lines = (i: import('../l3').L3Interface): string[] => {
    const out: string[] = [];
    if (i.kind === 'subif' || i.kind === 'svi' || i.kind === 'loopback') if (i.description) out.push(` description ${i.description}`);
    if (i.kind === 'subif' && i.encapVlan !== null) out.push(` encapsulation dot1Q ${i.encapVlan}${i.encapNative ? ' native' : ''}`);
    if (i.dhcp) out.push(' ip address dhcp');
    else if (i.ip && i.mask) out.push(` ip address ${i.ip} ${i.mask}`);
    else out.push(' no ip address');
    for (const h of i.helpers) out.push(` ip helper-address ${h}`);
    if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
    if (i.aclOut) out.push(` ip access-group ${i.aclOut} out`);
    if (i.natRole) out.push(` ip nat ${i.natRole}`);
    if (i.ospfCost) out.push(` ip ospf cost ${i.ospfCost}`);
    if (i.ospfPriority !== 1) out.push(` ip ospf priority ${i.ospfPriority}`);
    if (i.port && i.bandwidthKbps !== i.port.maxSpeed * 1000 && i.kind !== 'subif') out.push(` bandwidth ${i.bandwidthKbps}`);
    return out;
  };
  // Loopback lar
  for (const i of dev.stack.interfaces.filter((x) => x.kind === 'loopback')) blocks.push([`interface ${i.name}`, ...l3lines(i), ...(i.adminUp ? [] : [' shutdown'])]);
  for (const p of dev.ports) {
    if (p.media === 'console') continue;
    const b = [`interface ${p.name}`];
    const phys = dev.stack.interfaces.find((i) => i.kind === 'physical' && i.port === p);
    if (isSwitch(dev) && !p.switchport) b.push(' no switchport');
    b.push(...portLines(p, dev));
    if (phys) b.push(...l3lines(phys));
    if (!p.adminUp) b.push(' shutdown');
    blocks.push(b);
    for (const s of dev.stack.interfaces.filter((i) => i.kind === 'subif' && i.port === p).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      blocks.push([`interface ${s.name}`, ...l3lines(s), ...(s.adminUp ? [] : [' shutdown'])]);
    }
  }
  for (const i of dev.stack.interfaces.filter((x) => x.kind === 'svi').sort((a, b) => a.sviVlan! - b.sviVlan!)) {
    blocks.push([`interface ${i.name}`, ...l3lines(i), ...(i.adminUp ? [] : [' shutdown'])]);
  }
  return blocks;
}
