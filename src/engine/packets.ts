// Tarmoq paketlari (PDU) — real protokollar tuzilmasiga mos.
import type { MAC } from './util';

let frameIdCounter = 1;
export function nextFrameId() {
  return frameIdCounter++;
}

// ------------------------------------------------------------------ L2

export type EtherType = 'ARP' | 'IPv4' | 'STP' | 'CDP' | 'DTP' | 'LLDP';

export interface EthernetFrame {
  id: number;
  src: MAC;
  dst: MAC;
  /** 802.1Q teg (VLAN ID). undefined — tegsiz ramka */
  vlan?: number;
  /** 802.1p ustuvorlik (CoS 0..7) */
  cos?: number;
  etherType: EtherType;
  payload: ArpPacket | IPv4Packet | Bpdu | CdpPacket | DtpPacket;
  /** Kadr qancha qurilmadan o'tdi — sim ichidagi xavfsizlik chegarasi (broadcast storm oldini olish uchun) */
  hops?: number;
}

export interface ArpPacket {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: MAC;
  senderIp: string;
  targetMac: MAC;
  targetIp: string;
}

/** IEEE 802.1D / PVST+ konfiguratsiya BPDU */
export interface Bpdu {
  kind: 'bpdu';
  vlan: number;
  rootPriority: number;
  rootMac: MAC;
  rootCost: number;
  bridgePriority: number;
  bridgeMac: MAC;
  portId: number;
  messageAge: number;
  maxAge: number;
  helloTime: number;
  forwardDelay: number;
  tc: boolean;
  tca: boolean;
  rstp: boolean;
  /** RSTP: proposal/agreement */
  proposal?: boolean;
  agreement?: boolean;
}

export interface CdpPacket {
  kind: 'cdp';
  deviceId: string;
  platform: string;
  portId: string;
  capabilities: string; // "R S I" ...
  holdtime: number;
  version: string;
  address?: string;
  nativeVlan?: number;
  voiceVlan?: number;
  duplex: 'full' | 'half';
  /** PoE talabi (Vt) */
  powerRequested?: number;
}

export interface DtpPacket {
  kind: 'dtp';
  mode: 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';
  domain: string;
}

// ------------------------------------------------------------------ L3

export type IpProtocol = 'ICMP' | 'UDP' | 'TCP' | 'OSPF';

export interface IPv4Packet {
  kind: 'ipv4';
  src: string;
  dst: string;
  ttl: number;
  protocol: IpProtocol;
  id: number;
  /** DSCP (46 = EF, ovoz) */
  dscp: number;
  payload: IcmpMessage | UdpDatagram | TcpSegment | OspfPacket;
}

export interface IcmpMessage {
  kind: 'icmp';
  type: 'echo-request' | 'echo-reply' | 'dest-unreachable' | 'time-exceeded';
  /** dest-unreachable kodlari: 0 net, 1 host, 3 port, 13 admin-prohibited */
  code: number;
  ident: number;
  seq: number;
  dataSize: number;
  /** Xatolik xabarlarida asl paket sarlavhasi */
  original?: { src: string; dst: string; protocol: IpProtocol; ident?: number; seq?: number; srcPort?: number; dstPort?: number };
}

export interface OspfPacket {
  kind: 'ospf';
  type: 'hello' | 'lsu';
  routerId: string;
  area: number;
  helloInterval: number;
  deadInterval: number;
  neighbors: string[];
  mask: string;
  priority: number;
  dr?: string;
  lsa?: OspfLsa;
}

export interface OspfLsa {
  routerId: string;
  seq: number;
  links: { network: string; mask: string; cost: number; neighborId?: string; neighborIp?: string }[];
}

// ------------------------------------------------------------------ L4

export interface UdpDatagram {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  payload: DhcpMessage | DnsMessage | RtpPacket | SccpMessage | RawData | SyslogMessage;
}

export interface TcpFlags {
  syn?: boolean;
  ack?: boolean;
  fin?: boolean;
  rst?: boolean;
  psh?: boolean;
}

export interface TcpSegment {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: TcpFlags;
  window: number;
  dataSize: number;
  /** Ilova xabari (faqat xabarning oxirgi segmentida) */
  data?: AppMessage;
  /** Segment raqami / jami segmentlar */
  segIndex?: number;
  segCount?: number;
}

// ------------------------------------------------------------------ L7

export interface RawData {
  kind: 'raw';
  size: number;
  label?: string;
}

export interface DhcpOptions {
  mask?: string;
  router?: string;
  dns?: string[];
  domain?: string;
  lease?: number; // soniya
  serverId?: string;
  requestedIp?: string;
  /** Option 150 — Cisco IP telefonlar uchun TFTP server */
  tftp?: string;
  hostname?: string;
}

export interface DhcpMessage {
  kind: 'dhcp';
  op: 'DISCOVER' | 'OFFER' | 'REQUEST' | 'ACK' | 'NAK' | 'RELEASE' | 'DECLINE';
  xid: number;
  chaddr: MAC;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  broadcast: boolean;
  options: DhcpOptions;
}

export interface DnsMessage {
  kind: 'dns';
  qr: 'query' | 'response';
  txid: number;
  name: string;
  qtype: 'A' | 'CNAME' | 'PTR';
  answers: { name: string; type: 'A' | 'CNAME'; value: string; ttl: number }[];
  rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
}

export interface RtpPacket {
  kind: 'rtp';
  ssrc: number;
  seq: number;
  timestamp: number;
  codec: 'G.711' | 'G.729';
  size: number;
  sentAt: number;
  callId: number;
}

export interface SyslogMessage {
  kind: 'syslog';
  text: string;
}

/** Cisco SCCP (Skinny) — IP telefon <-> CallManager Express signalizatsiyasi (TCP 2000) */
export interface SccpMessage {
  kind: 'sccp';
  size: number;
  msg:
    | 'Register'
    | 'RegisterAck'
    | 'RegisterReject'
    | 'KeepAlive'
    | 'KeepAliveAck'
    | 'OffHook'
    | 'Dial'
    | 'CallState'
    | 'StartMedia'
    | 'StopMedia'
    | 'OnHook'
    | 'Answer'
    | 'DisplayText';
  mac?: MAC;
  deviceName?: string;
  model?: string;
  lines?: { dn: string; label?: string }[];
  dialed?: string;
  callId?: number;
  state?: 'idle' | 'dialtone' | 'ringout' | 'ringing' | 'connected' | 'busy' | 'unknown-number' | 'hangup';
  remoteNumber?: string;
  remoteIp?: string;
  remotePort?: number;
  localPort?: number;
  codec?: 'G.711' | 'G.729';
  text?: string;
  reason?: string;
}

export interface HttpRequest {
  kind: 'http-req';
  method: 'GET' | 'POST';
  host: string;
  path: string;
  size: number;
  reqId: number;
}

export interface HttpResponse {
  kind: 'http-res';
  status: number;
  statusText: string;
  size: number;
  body?: string;
  reqId: number;
  serverMs: number;
}

export interface TerminalData {
  kind: 'term';
  text: string;
  size: number;
  /** ssh — shifrlangan */
  secure: boolean;
  /** Server: keyingi kiritish parol (ko'rsatilmaydi) */
  secretInput?: boolean;
  /** Mijoz: Ctrl+C / Ctrl+Shift+6 */
  interrupt?: boolean;
}

export interface FtpData {
  kind: 'ftp';
  text: string;
  size: number;
}

export type AppMessage = HttpRequest | HttpResponse | TerminalData | FtpData | RawData | SccpMessage;

// ------------------------------------------------------------------ o'lchamlar

export function appSize(m: AppMessage | undefined): number {
  if (!m) return 0;
  if (m.kind === 'sccp') return 60 + (m.text?.length ?? 0);
  return m.size;
}

function udpPayloadSize(p: UdpDatagram['payload']): number {
  switch (p.kind) {
    case 'dhcp':
      return 300;
    case 'dns':
      return 30 + p.name.length + p.answers.length * 16;
    case 'rtp':
      return p.size + 12;
    case 'sccp':
      return 60 + (p.text?.length ?? 0);
    case 'syslog':
      return p.text.length + 20;
    case 'raw':
      return p.size;
  }
}

export function ipPacketSize(p: IPv4Packet): number {
  let l4 = 0;
  const pl = p.payload;
  switch (pl.kind) {
    case 'icmp':
      l4 = 8 + pl.dataSize + (pl.original ? 28 : 0);
      break;
    case 'udp':
      l4 = 8 + udpPayloadSize(pl.payload);
      break;
    case 'tcp':
      l4 = 20 + pl.dataSize;
      break;
    case 'ospf':
      l4 = 44 + pl.neighbors.length * 4 + (pl.lsa ? 24 + pl.lsa.links.length * 12 : 0);
      break;
  }
  return 20 + l4;
}

/** Ethernet kadr o'lchami baytlarda (preambula/IFG bilan birga — liniyada egallagan joy) */
export function frameWireSize(f: EthernetFrame): number {
  let payload = 0;
  switch (f.payload.kind) {
    case 'arp':
      payload = 28;
      break;
    case 'ipv4':
      payload = ipPacketSize(f.payload);
      break;
    case 'bpdu':
      payload = f.payload.rstp ? 39 : 35;
      break;
    case 'cdp':
      payload = 300;
      break;
    case 'dtp':
      payload = 40;
      break;
  }
  const l2 = Math.max(64, 14 + (f.vlan !== undefined ? 4 : 0) + payload + 4);
  return l2 + 8 + 12; // preambula + inter-frame gap
}

export function frameSize(f: EthernetFrame): number {
  return frameWireSize(f) - 20;
}

// ------------------------------------------------------------------ tavsiflar (UI uchun)

export function describeFrame(f: EthernetFrame): { proto: string; info: string } {
  const p = f.payload;
  switch (p.kind) {
    case 'arp':
      return p.op === 'request'
        ? { proto: 'ARP', info: `Who has ${p.targetIp}? Tell ${p.senderIp}` }
        : { proto: 'ARP', info: `${p.senderIp} is at ${p.senderMac}` };
    case 'bpdu':
      return { proto: p.rstp ? 'RSTP' : 'STP', info: `VLAN${p.vlan} Root=${p.rootPriority}/${p.rootMac} Cost=${p.rootCost} Port=0x${p.portId.toString(16)}` };
    case 'cdp':
      return { proto: 'CDP', info: `Device ID: ${p.deviceId}  Port ID: ${p.portId}${p.voiceVlan ? `  Voice VLAN: ${p.voiceVlan}` : ''}` };
    case 'dtp':
      return { proto: 'DTP', info: `Mode: ${p.mode}` };
    case 'ipv4':
      return describeIp(p);
  }
}

export function describeIp(p: IPv4Packet): { proto: string; info: string } {
  const pl = p.payload;
  switch (pl.kind) {
    case 'icmp': {
      const t: Record<string, string> = {
        'echo-request': 'Echo (ping) request',
        'echo-reply': 'Echo (ping) reply',
        'dest-unreachable': 'Destination unreachable',
        'time-exceeded': 'Time-to-live exceeded',
      };
      return { proto: 'ICMP', info: `${p.src} → ${p.dst} ${t[pl.type]} seq=${pl.seq} ttl=${p.ttl}` };
    }
    case 'ospf':
      return { proto: 'OSPF', info: `${pl.type.toUpperCase()} RID ${pl.routerId} area ${pl.area}` };
    case 'udp': {
      const u = pl.payload;
      switch (u.kind) {
        case 'dhcp':
          return { proto: 'DHCP', info: `DHCP ${u.op} xid=0x${u.xid.toString(16)}${u.yiaddr !== '0.0.0.0' ? ' ip=' + u.yiaddr : ''}` };
        case 'dns':
          return { proto: 'DNS', info: `${u.qr === 'query' ? 'Query' : 'Response'} ${u.qtype} ${u.name}${u.answers.length ? ' → ' + u.answers.map((a) => a.value).join(',') : ''}${u.rcode !== 'NOERROR' ? ' ' + u.rcode : ''}` };
        case 'rtp':
          return { proto: 'RTP', info: `${u.codec} seq=${u.seq} SSRC=0x${u.ssrc.toString(16)}` };
        case 'sccp':
          return { proto: 'SCCP', info: `${u.msg}${u.dialed ? ' ' + u.dialed : ''}${u.state ? ' ' + u.state : ''}` };
        case 'syslog':
          return { proto: 'Syslog', info: u.text };
        case 'raw':
          return { proto: 'UDP', info: `${p.src}:${pl.srcPort} → ${p.dst}:${pl.dstPort} ${u.size}B` };
      }
      break;
    }
    case 'tcp': {
      const fl = Object.entries(pl.flags)
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase())
        .join(',');
      const d = pl.data;
      let proto = 'TCP';
      if (pl.srcPort === 80 || pl.dstPort === 80 || pl.srcPort === 443 || pl.dstPort === 443) proto = pl.srcPort === 443 || pl.dstPort === 443 ? 'HTTPS' : 'HTTP';
      else if (pl.srcPort === 22 || pl.dstPort === 22) proto = 'SSH';
      else if (pl.srcPort === 23 || pl.dstPort === 23) proto = 'Telnet';
      else if (pl.srcPort === 21 || pl.dstPort === 21) proto = 'FTP';
      else if (pl.srcPort === 2000 || pl.dstPort === 2000) proto = 'SCCP';
      let info = `${pl.srcPort} → ${pl.dstPort} [${fl}] Seq=${pl.seq} Ack=${pl.ack} Len=${pl.dataSize}`;
      if (d?.kind === 'http-req') info = `${d.method} ${d.path} HTTP/1.1 Host: ${d.host}`;
      if (d?.kind === 'http-res') info = `HTTP/1.1 ${d.status} ${d.statusText} (${d.size} B)`;
      if (d?.kind === 'sccp') info = `${d.msg}${d.dialed ? ' ' + d.dialed : ''}${d.state ? ' ' + d.state : ''}${d.lines ? ' DN=' + d.lines.map((l) => l.dn).join(',') : ''}`;
      if (!d && proto !== 'TCP' && pl.dataSize === 0) proto = 'TCP';
      return { proto, info };
    }
  }
  return { proto: 'IPv4', info: `${p.src} → ${p.dst}` };
}

/** OSI qatlamlari bo'yicha batafsil tavsif (Simulyatsiya rejimidagi PDU oynasi uchun) */
export function frameLayers(f: EthernetFrame): { layer: string; lines: string[] }[] {
  const out: { layer: string; lines: string[] }[] = [];
  out.push({
    layer: 'Qatlam 2: Ethernet II' + (f.vlan !== undefined ? ' + 802.1Q' : ''),
    lines: [
      `Manba MAC: ${f.src}`,
      `Qabul qiluvchi MAC: ${f.dst}`,
      ...(f.vlan !== undefined ? [`802.1Q VLAN ID: ${f.vlan}  CoS: ${f.cos ?? 0}`] : []),
      `EtherType: ${f.etherType === 'IPv4' ? '0x0800 (IPv4)' : f.etherType === 'ARP' ? '0x0806 (ARP)' : f.etherType}`,
      `Kadr o'lchami: ${frameSize(f)} bayt`,
    ],
  });
  const p = f.payload;
  if (p.kind === 'arp') {
    out.push({ layer: 'ARP', lines: [`Operatsiya: ${p.op}`, `Sender: ${p.senderIp} / ${p.senderMac}`, `Target: ${p.targetIp} / ${p.targetMac}`] });
  } else if (p.kind === 'bpdu') {
    out.push({
      layer: p.rstp ? 'Rapid STP BPDU' : 'STP BPDU (802.1D)',
      lines: [
        `Root ID: ${p.rootPriority} / ${p.rootMac}`,
        `Root Path Cost: ${p.rootCost}`,
        `Bridge ID: ${p.bridgePriority} / ${p.bridgeMac}`,
        `Port ID: 0x${p.portId.toString(16)}`,
        `Hello ${p.helloTime}s  MaxAge ${p.maxAge}s  FwdDelay ${p.forwardDelay}s`,
        `Flags: ${p.tc ? 'TC ' : ''}${p.proposal ? 'Proposal ' : ''}${p.agreement ? 'Agreement' : ''}`,
      ],
    });
  } else if (p.kind === 'cdp') {
    out.push({
      layer: 'CDP v2',
      lines: [`Device ID: ${p.deviceId}`, `Platform: ${p.platform}`, `Port ID: ${p.portId}`, `Capabilities: ${p.capabilities}`, `Native VLAN: ${p.nativeVlan ?? '-'}`, `Voice VLAN: ${p.voiceVlan ?? '-'}`],
    });
  } else if (p.kind === 'dtp') {
    out.push({ layer: 'DTP', lines: [`Mode: ${p.mode}`] });
  } else if (p.kind === 'ipv4') {
    out.push({
      layer: 'Qatlam 3: IPv4',
      lines: [`Manba IP: ${p.src}`, `Qabul qiluvchi IP: ${p.dst}`, `TTL: ${p.ttl}`, `Protokol: ${p.protocol}`, `DSCP: ${p.dscp}${p.dscp === 46 ? ' (EF — ovoz)' : ''}`, `Uzunlik: ${ipPacketSize(p)} bayt`, `ID: ${p.id}`],
    });
    const pl = p.payload;
    if (pl.kind === 'icmp') {
      out.push({ layer: 'ICMP', lines: [`Turi: ${pl.type}`, `Kod: ${pl.code}`, `Identifier: ${pl.ident}  Seq: ${pl.seq}`, `Ma'lumot: ${pl.dataSize} bayt`] });
    } else if (pl.kind === 'udp') {
      out.push({ layer: 'Qatlam 4: UDP', lines: [`Manba port: ${pl.srcPort}`, `Qabul port: ${pl.dstPort}`] });
      const u = pl.payload;
      if (u.kind === 'dhcp')
        out.push({
          layer: 'Qatlam 7: DHCP',
          lines: [
            `Xabar: DHCP${u.op}`,
            `XID: 0x${u.xid.toString(16)}`,
            `Client MAC: ${u.chaddr}`,
            `ciaddr: ${u.ciaddr}  yiaddr: ${u.yiaddr}`,
            `siaddr: ${u.siaddr}  giaddr: ${u.giaddr}`,
            ...(u.options.mask ? [`Subnet mask: ${u.options.mask}`] : []),
            ...(u.options.router ? [`Router: ${u.options.router}`] : []),
            ...(u.options.dns?.length ? [`DNS: ${u.options.dns.join(', ')}`] : []),
            ...(u.options.tftp ? [`Option 150 (TFTP): ${u.options.tftp}`] : []),
            ...(u.options.lease ? [`Lease: ${u.options.lease}s`] : []),
          ],
        });
      if (u.kind === 'dns') out.push({ layer: 'Qatlam 7: DNS', lines: [`${u.qr} ${u.qtype} ${u.name}`, `rcode: ${u.rcode}`, ...u.answers.map((a) => `${a.name} ${a.type} ${a.value} TTL=${a.ttl}`)] });
      if (u.kind === 'rtp') out.push({ layer: 'Qatlam 7: RTP (ovoz)', lines: [`Codec: ${u.codec}`, `Seq: ${u.seq}`, `SSRC: 0x${u.ssrc.toString(16)}`, `Payload: ${u.size} bayt`] });
      if (u.kind === 'sccp') out.push({ layer: 'Qatlam 7: SCCP (Skinny)', lines: [`Xabar: ${u.msg}`, ...(u.dialed ? [`Terilgan: ${u.dialed}`] : []), ...(u.state ? [`Holat: ${u.state}`] : []), ...(u.lines ? [`Liniyalar: ${u.lines.map((l) => l.dn).join(', ')}`] : [])] });
    } else if (pl.kind === 'tcp') {
      out.push({
        layer: 'Qatlam 4: TCP',
        lines: [
          `Manba port: ${pl.srcPort}`,
          `Qabul port: ${pl.dstPort}`,
          `Seq: ${pl.seq}  Ack: ${pl.ack}`,
          `Bayroqlar: ${Object.entries(pl.flags).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ') || '-'}`,
          `Window: ${pl.window}`,
          `Ma'lumot: ${pl.dataSize} bayt${pl.segCount && pl.segCount > 1 ? ` (segment ${pl.segIndex! + 1}/${pl.segCount})` : ''}`,
        ],
      });
      const d = pl.data;
      if (d?.kind === 'http-req') out.push({ layer: 'Qatlam 7: HTTP', lines: [`${d.method} ${d.path} HTTP/1.1`, `Host: ${d.host}`] });
      if (d?.kind === 'http-res') out.push({ layer: 'Qatlam 7: HTTP', lines: [`HTTP/1.1 ${d.status} ${d.statusText}`, `Content-Length: ${d.size}`] });
      if (d?.kind === 'sccp') out.push({ layer: 'Qatlam 7: SCCP (Skinny)', lines: [`Xabar: ${d.msg}`, ...(d.dialed ? [`Terilgan: ${d.dialed}`] : []), ...(d.state ? [`Holat: ${d.state}`] : []), ...(d.lines ? [`Liniyalar: ${d.lines.map((l) => l.dn).join(', ')}`] : [])] });
      if (d?.kind === 'term') out.push({ layer: d.secure ? 'Qatlam 7: SSH (shifrlangan)' : 'Qatlam 7: Telnet (ochiq matn!)', lines: [d.secure ? '<shifrlangan ma\'lumot>' : JSON.stringify(d.text).slice(0, 80)] });
    } else if (pl.kind === 'ospf') {
      out.push({ layer: 'OSPF', lines: [`Turi: ${pl.type}`, `Router ID: ${pl.routerId}`, `Area: ${pl.area}`, `Qo'shnilar: ${pl.neighbors.join(', ') || '-'}`] });
    }
  }
  return out;
}

export function cloneFrame(f: EthernetFrame): EthernetFrame {
  // Payload o'zgarmas deb qaraladi (har bir qurilma yangi paket yaratadi), shuning uchun sayoz nusxa yetarli.
  return { ...f, id: nextFrameId() };
}
