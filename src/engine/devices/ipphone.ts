// IP telefon (Cisco 7960 ga o'xshash): orqa panelda "SW" (uplink, PoE) va "PC" portlari, ichki 3-portli switch,
// CDP orqali Voice VLAN ni o'rganadi, DHCP (option 150) orqali CallManager manzilini oladi, SCCP bilan ro'yxatdan o'tadi,
// qo'ng'iroqlarda RTP (G.711, 20 ms, DSCP EF) oqimi yuboradi va ovoz sifatini (MOS) hisoblaydi.
import { Device, DeviceKind } from '../device';
import type { Port } from '../port';
import { IpStack } from '../ipstack';
import { L3Interface } from '../l3';
import type { EthernetFrame, RtpPacket, SccpMessage, CdpPacket } from '../packets';
import { CdpAgent, CdpHost, CdpNeighbor } from '../protocols/cdp';
import { DhcpClient, installDhcpPort68 } from '../protocols/dhcp';
import type { TcpConn } from '../protocols/tcp';
import { BROADCAST_MAC, isValidIp } from '../util';

export type PhoneState = 'off' | 'vlan' | 'dhcp' | 'tftp' | 'registering' | 'registered' | 'error';
export type CallState = 'idle' | 'offhook' | 'ringout' | 'ringing' | 'connected' | 'busy' | 'unknown';

export interface VoiceStats {
  sent: number;
  received: number;
  lost: number;
  jitterMs: number;
  latencyMs: number;
  mos: number;
  lastSeq: number;
  lastTransit: number;
}

function sccp(m: Omit<SccpMessage, 'kind' | 'size'>): SccpMessage {
  return { kind: 'sccp', size: 80 + (m.text?.length ?? 0), ...m };
}

/** ITU-T G.107 E-model (soddalashtirilgan) — MOS bahosi */
export function computeMos(latencyMs: number, jitterMs: number, lossPct: number): number {
  const d = latencyMs + jitterMs * 2 + 10;
  const Id = d < 177.3 ? 0.024 * d : 0.024 * d + 0.11 * (d - 177.3);
  const Ie = 0 + (95 - 0) * (lossPct / (lossPct + 25.1));
  const R = Math.max(0, Math.min(100, 93.2 - Id - Ie));
  const mos = 1 + 0.035 * R + 7e-6 * R * (R - 60) * (100 - R);
  return Math.max(1, Math.min(4.5, mos));
}

export class IpPhone extends Device implements CdpHost {
  readonly kind: DeviceKind = 'ipphone';
  stack: IpStack;
  cpu: L3Interface;
  dhcp: DhcpClient;
  cdp: CdpAgent;
  swPort: Port;
  pcPort: Port;
  voiceVlan: number | null = null;
  state: PhoneState = 'off';
  statusText = '';
  lines: { dn: string; label?: string }[] = [];
  callState: CallState = 'idle';
  callId = 0;
  remoteNumber = '';
  dialed = '';
  voice: VoiceStats = this.emptyVoice();
  callLog: string[] = [];
  /** Statik sozlama (DHCP o'rniga) */
  manualIp: { ip: string; mask: string; gw: string; tftp: string } | null = null;
  platform = 'Cisco IP Phone 7960';
  capabilities = 'H P';
  version = 'P00308010200';
  private conn: TcpConn | null = null;
  private cdpWait: any = null;
  private rtp: { stop: () => void; localPort: number } | null = null;
  private keepAliveStop: (() => void) | null = null;
  private regRetry: any = null;
  private bridgeMacs = new Map<string, Port>();

  constructor(label = 'IP Phone0', id?: string) {
    super('7960', label, id);
    this.procDelayMs = 0.02;
    this.poeRequiredW = 6.3;
    this.acPower = false;
    this.swPort = this.addPort({ name: 'Switch', media: 'copper', speeds: [10, 100], mdi: 'MDI', autoMdix: true, poePd: true, label: 'SW' }, '00:0f:24');
    this.pcPort = this.addPort({ name: 'PC', media: 'copper', speeds: [10, 100], mdi: 'MDIX', autoMdix: true, label: 'PC' }, '00:0f:24');
    this.stack = new IpStack(this, { ipRouting: false, defaultTtl: 64, arpQueue: 3, arpTimeoutMs: 300_000 });
    this.cpu = new L3Interface({ name: 'Voice', kind: 'host', mac: this.swPort.mac, port: this.swPort, output: (f) => this.cpuOut(f), lineUp: () => this.swPort.operUp });
    this.stack.addInterface(this.cpu);
    this.cdp = new CdpAgent(this);
    this.dhcp = new DhcpClient(this.stack, this.cpu, {
      hostname: () => `SEP${this.swPort.mac.replace(/:/g, '').toUpperCase()}`,
      apipa: false,
      onBound: () => this.onDhcpBound(),
      onFail: () => this.setStatus('error', 'DHCP javob yo\'q (IP olinmadi)'),
    });
    installDhcpPort68(this.stack, () => [this.dhcp]);
  }

  private emptyVoice(): VoiceStats {
    return { sent: 0, received: 0, lost: 0, jitterMs: 0, latencyMs: 0, mos: 0, lastSeq: -1, lastTransit: -1 };
  }

  get device() {
    return this;
  }

  get mac() {
    return this.swPort.mac;
  }

  get primaryDn() {
    return this.lines[0]?.dn ?? '';
  }

  // ------------------------------------------------------------ CdpHost
  cdpPorts() {
    return [this.swPort];
  }
  address() {
    return this.cpu.ip ?? undefined;
  }
  portVlanInfo() {
    return {};
  }
  sendCdp(p: Port, f: EthernetFrame) {
    p.send(f);
  }
  onCdpNeighbor(n: CdpNeighbor, pkt: CdpPacket) {
    if (n.port !== this.swPort) return;
    const v = pkt.voiceVlan ?? null;
    if (v !== this.voiceVlan) {
      this.voiceVlan = v;
      this.console(`CDP: Voice VLAN ${v ?? 'yo\'q'} (${pkt.deviceId} ${pkt.portId})`);
      if (this.state !== 'off') this.startNetwork();
    } else if (this.state === 'vlan') this.startNetwork();
  }

  // ------------------------------------------------------------ ichki switch
  receive(port: Port, f: EthernetFrame) {
    if (port === this.swPort) {
      if (f.payload.kind === 'cdp') {
        this.cdp.receive(port, f.payload);
        return;
      }
      if (f.payload.kind === 'bpdu' || f.payload.kind === 'dtp') {
        if (f.vlan === undefined) this.forwardPc(f);
        return;
      }
      const tagged = f.vlan !== undefined && f.vlan !== 0;
      const toCpu = f.dst === this.cpu.mac || f.dst === BROADCAST_MAC || f.dst.startsWith('01:00:5e');
      if (tagged) {
        if (f.vlan === this.voiceVlan && toCpu) this.stack.receiveFrame(this.cpu, { ...f, vlan: undefined });
        return;
      }
      // tegsiz (data VLAN)
      if (this.voiceVlan === null && toCpu) this.stack.receiveFrame(this.cpu, f);
      if (f.dst !== this.cpu.mac) this.forwardPc(f);
      return;
    }
    if (port === this.pcPort) {
      if (f.payload.kind === 'cdp') return;
      if (f.vlan !== undefined) return;
      this.bridgeMacs.set(f.src, port);
      this.swPort.send({ ...f });
    }
  }

  private forwardPc(f: EthernetFrame) {
    if (!this.pcPort.operUp) return;
    this.pcPort.send({ ...f });
  }

  private cpuOut(f: EthernetFrame) {
    if (this.voiceVlan !== null) this.swPort.send({ ...f, vlan: this.voiceVlan, cos: f.cos ?? 5 });
    else this.swPort.send(f);
  }

  // ------------------------------------------------------------ yuklanish
  private setStatus(s: PhoneState, text: string) {
    this.state = s;
    this.statusText = text;
    this.net?.bump();
  }

  onPowerOn() {
    this.stack.reset();
    this.voiceVlan = null;
    this.lines = [];
    this.callState = 'idle';
    this.setStatus('vlan', 'Configuring VLAN (CDP kutilmoqda)...');
    if (this.swPort.operUp) this.onLinkChange(this.swPort, true);
  }

  onPowerOff() {
    this.stack.reset();
    this.cdp.halt();
    this.stopRtp();
    this.keepAliveStop?.();
    this.conn = null;
    this.dhcp.stop();
    this.cpu.ip = null;
    this.cpu.mask = null;
    this.state = 'off';
    this.statusText = '';
    this.lines = [];
    this.callState = 'idle';
  }

  onLinkChange(port: Port, up: boolean) {
    if (port !== this.swPort) return;
    if (!up) {
      this.cdp.linkDown(port);
      this.setStatus('vlan', 'Tarmoq kabeli uzilgan');
      return;
    }
    this.cdp.start();
    this.cdp.linkUp(port);
    this.setStatus('vlan', 'Configuring VLAN...');
    this.clearTimer(this.cdpWait);
    // CDP kelmasa 4 soniyadan keyin tegsiz VLAN da davom etadi
    this.cdpWait = this.setTimer(4000, () => {
      if (this.state === 'vlan') this.startNetwork();
    });
  }

  private startNetwork() {
    this.clearTimer(this.cdpWait);
    this.keepAliveStop?.();
    this.conn?.abort();
    this.conn = null;
    this.lines = [];
    if (this.manualIp && isValidIp(this.manualIp.ip)) {
      this.dhcp.stop();
      this.cpu.dhcp = false;
      this.cpu.ip = this.manualIp.ip;
      this.cpu.mask = this.manualIp.mask;
      this.stack.defaultGateway = this.manualIp.gw || null;
      this.stack.invalidate();
      this.stack.gratuitousArp(this.cpu);
      this.register(this.manualIp.tftp);
      return;
    }
    this.cpu.dhcp = true;
    this.setStatus('dhcp', `Configuring IP${this.voiceVlan ? ` (Voice VLAN ${this.voiceVlan})` : ''}...`);
    this.dhcp.start();
  }

  private onDhcpBound() {
    const st = this.cpu.dhcpState!;
    this.stack.defaultGateway = st.gateway ?? null;
    this.stack.invalidate();
    if (!st.tftp) {
      this.setStatus('error', 'TFTP server yo\'q (DHCP option 150 sozlanmagan)');
      return;
    }
    this.register(st.tftp);
  }

  private register(cme: string) {
    this.setStatus('registering', `Registering (${cme})...`);
    this.clearTimer(this.regRetry);
    const conn = this.stack.tcp.connect(cme, 2000, {
      onOpen: (c) => c.send(sccp({ msg: 'Register', mac: this.mac, model: '7960', deviceName: `SEP${this.mac.replace(/:/g, '').toUpperCase()}` })),
      onData: (_c, m) => {
        if (m.kind === 'sccp') this.onSccp(m);
      },
      onClose: (_c, reason) => {
        this.conn = null;
        this.keepAliveStop?.();
        if (this.state === 'off') return;
        this.stopRtp();
        this.callState = 'idle';
        this.setStatus('registering', reason === 'refused' ? 'CallManager rad etdi (telephony-service yo\'q?)' : 'CallManager bilan aloqa yo\'q');
        this.regRetry = this.setTimer(10_000, () => this.register(cme));
      },
    });
    this.conn = conn;
    if (!conn) {
      this.setStatus('registering', 'CallManager ga yo\'l yo\'q (gateway?)');
      this.regRetry = this.setTimer(10_000, () => this.register(cme));
    }
  }

  private onSccp(m: SccpMessage) {
    switch (m.msg) {
      case 'RegisterAck':
        this.lines = m.lines ?? [];
        this.setStatus('registered', this.lines.length ? `Ro'yxatdan o'tdi: ${this.lines.map((l) => l.dn).join(', ')}` : "Ro'yxatdan o'tdi (raqam biriktirilmagan)");
        this.keepAliveStop?.();
        this.keepAliveStop = this.every(30_000, () => this.conn?.send(sccp({ msg: 'KeepAlive' })));
        break;
      case 'RegisterReject':
        this.setStatus('error', `Ro'yxatdan o'tish rad etildi: ${m.reason ?? ''}`);
        break;
      case 'CallState':
        this.onCallState(m);
        break;
      case 'StartMedia':
        this.startRtp(m.remoteIp!, m.remotePort!, m.localPort!, m.callId!);
        break;
      case 'StopMedia':
        this.stopRtp();
        break;
    }
    this.net?.bump();
  }

  private onCallState(m: SccpMessage) {
    switch (m.state) {
      case 'ringout':
        this.callState = 'ringout';
        this.callId = m.callId ?? 0;
        this.remoteNumber = m.remoteNumber ?? '';
        break;
      case 'ringing':
        this.callState = 'ringing';
        this.callId = m.callId ?? 0;
        this.remoteNumber = m.remoteNumber ?? '';
        this.callLog.push(`Kiruvchi: ${this.remoteNumber}`);
        break;
      case 'connected':
        this.callState = 'connected';
        this.remoteNumber = m.remoteNumber ?? this.remoteNumber;
        break;
      case 'busy':
        this.callState = 'busy';
        break;
      case 'unknown-number':
        this.callState = 'unknown';
        break;
      case 'hangup':
        this.stopRtp();
        this.callState = 'idle';
        this.remoteNumber = '';
        break;
    }
  }

  // ------------------------------------------------------------ foydalanuvchi amallari
  dial(number: string) {
    if (this.state !== 'registered' || !this.conn) return false;
    this.dialed = number;
    this.callState = 'offhook';
    this.callLog.push(`Chiquvchi: ${number}`);
    this.conn.send(sccp({ msg: 'Dial', dialed: number }));
    this.net?.bump();
    return true;
  }

  answer() {
    if (this.callState !== 'ringing' || !this.conn) return;
    this.conn.send(sccp({ msg: 'Answer', callId: this.callId }));
  }

  hangup() {
    this.stopRtp();
    if (this.conn && this.callState !== 'idle') this.conn.send(sccp({ msg: 'OnHook' }));
    this.callState = 'idle';
    this.remoteNumber = '';
    this.dialed = '';
    this.net?.bump();
  }

  // ------------------------------------------------------------ RTP
  private startRtp(remoteIp: string, remotePort: number, localPort: number, callId: number) {
    this.stopRtp();
    this.voice = this.emptyVoice();
    const ssrc = Math.floor(Math.random() * 0xffffffff);
    let seq = 0;
    this.stack.udpBind(localPort, (_pkt, udp) => {
      const p = udp.payload as RtpPacket;
      if (p.kind !== 'rtp') return;
      const v = this.voice;
      v.received++;
      if (v.lastSeq >= 0 && p.seq > v.lastSeq + 1) v.lost += p.seq - v.lastSeq - 1;
      v.lastSeq = Math.max(v.lastSeq, p.seq);
      const transit = this.now - p.sentAt;
      if (v.lastTransit >= 0) {
        const dd = Math.abs(transit - v.lastTransit);
        v.jitterMs += (dd - v.jitterMs) / 16;
      }
      v.lastTransit = transit;
      v.latencyMs = v.latencyMs ? v.latencyMs * 0.9 + transit * 0.1 : transit;
      const lossPct = v.received + v.lost > 0 ? (v.lost / (v.received + v.lost)) * 100 : 0;
      v.mos = computeMos(v.latencyMs, v.jitterMs, lossPct);
    });
    const stop = this.every(20, () => {
      const pkt: RtpPacket = { kind: 'rtp', ssrc, seq: seq++, timestamp: seq * 160, codec: 'G.711', size: 160, sentAt: this.now, callId };
      this.voice.sent++;
      this.stack.sendUdp(remoteIp, localPort, remotePort, pkt, { dscp: 46 });
    }, 20);
    this.rtp = { stop, localPort };
  }

  private stopRtp() {
    if (!this.rtp) return;
    this.rtp.stop();
    this.stack.udpUnbind(this.rtp.localPort);
    this.rtp = null;
  }

  tick1s() {
    this.stack.tick();
    this.cdp.expire();
  }

  ipSummary() {
    return this.cpu.ip ? [`IP: ${this.cpu.ip}${this.voiceVlan ? ` (VLAN ${this.voiceVlan})` : ''}`, ...(this.primaryDn ? [`Raqam: ${this.primaryDn}`] : [])] : [];
  }

  saveConfig() {
    return { manualIp: this.manualIp, acPower: this.acPower };
  }

  loadConfig(cfg: any) {
    this.manualIp = cfg?.manualIp ?? null;
    if (cfg?.acPower !== undefined) this.acPower = cfg.acPower;
  }
}
