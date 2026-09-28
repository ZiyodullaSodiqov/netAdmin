// Cisco Discovery Protocol — qo'shni qurilmalarni aniqlash, IP telefonlarga Voice VLAN berish.
import type { Device } from '../device';
import type { Port } from '../port';
import type { CdpPacket, EthernetFrame } from '../packets';
import { nextFrameId } from '../packets';
import { CISCO_MCAST_MAC } from '../util';

export interface CdpNeighbor {
  port: Port;
  deviceId: string;
  platform: string;
  portId: string;
  capabilities: string;
  address?: string;
  nativeVlan?: number;
  voiceVlan?: number;
  version: string;
  expires: number;
  holdtime: number;
}

export interface CdpHost {
  device: Device;
  platform: string;
  capabilities: string;
  version: string;
  /** CDP yuboriladigan portlar */
  cdpPorts(): Port[];
  address(): string | undefined;
  portVlanInfo(p: Port): { nativeVlan?: number; voiceVlan?: number };
  /** Kadrni portdan chiqarish (switchport bo'lsa — nativ VLAN da, tegsiz) */
  sendCdp(p: Port, frame: EthernetFrame): void;
  onCdpNeighbor?(n: CdpNeighbor, pkt: CdpPacket): void;
}

export class CdpAgent {
  host: CdpHost;
  enabled = true;
  timer = 60;
  holdtime = 180;
  neighbors = new Map<Port, CdpNeighbor>();
  disabledPorts = new Set<Port>();
  private stop: (() => void) | null = null;

  constructor(host: CdpHost) {
    this.host = host;
  }

  start() {
    this.stop?.();
    this.stop = this.host.device.every(this.timer * 1000, () => this.advertiseAll(), 1500);
  }

  halt() {
    this.stop?.();
    this.stop = null;
    this.neighbors.clear();
  }

  advertiseAll() {
    if (!this.enabled) return;
    for (const p of this.host.cdpPorts()) if (p.operUp) this.advertise(p);
    this.expire();
  }

  advertise(p: Port) {
    if (!this.enabled || this.disabledPorts.has(p) || !p.operUp) return;
    const v = this.host.portVlanInfo(p);
    const pkt: CdpPacket = {
      kind: 'cdp',
      deviceId: this.host.device.hostname,
      platform: this.host.platform,
      portId: p.name,
      capabilities: this.host.capabilities,
      holdtime: this.holdtime,
      version: this.host.version,
      address: this.host.address(),
      nativeVlan: v.nativeVlan,
      voiceVlan: v.voiceVlan,
      duplex: 'full',
    };
    this.host.sendCdp(p, { id: nextFrameId(), src: p.mac, dst: CISCO_MCAST_MAC, etherType: 'CDP', payload: pkt });
  }

  linkUp(p: Port) {
    // Link ko'tarilgandan so'ng tez orada birinchi e'lon
    this.host.device.setTimer(300 + Math.random() * 200, () => this.advertise(p));
  }

  linkDown(p: Port) {
    this.neighbors.delete(p);
  }

  receive(p: Port, pkt: CdpPacket) {
    if (!this.enabled || this.disabledPorts.has(p)) return;
    const n: CdpNeighbor = {
      port: p,
      deviceId: pkt.deviceId,
      platform: pkt.platform,
      portId: pkt.portId,
      capabilities: pkt.capabilities,
      address: pkt.address,
      nativeVlan: pkt.nativeVlan,
      voiceVlan: pkt.voiceVlan,
      version: pkt.version,
      holdtime: pkt.holdtime,
      expires: this.host.device.now + pkt.holdtime * 1000,
    };
    const isNew = !this.neighbors.has(p);
    this.neighbors.set(p, n);
    // Native VLAN mos kelmasligi
    const mine = this.host.portVlanInfo(p).nativeVlan;
    if (mine !== undefined && pkt.nativeVlan !== undefined && mine !== pkt.nativeVlan) {
      this.host.device.syslog('CDP', 4, 'NATIVE_VLAN_MISMATCH', `Native VLAN mismatch discovered on ${p.name} (${mine}), with ${pkt.deviceId} ${pkt.portId} (${pkt.nativeVlan}).`);
    }
    this.host.onCdpNeighbor?.(n, pkt);
    if (isNew) this.advertise(p);
  }

  expire() {
    const now = this.host.device.now;
    for (const [p, n] of [...this.neighbors]) if (n.expires < now) this.neighbors.delete(p);
  }

  /** show cdp neighbors */
  table(): string[] {
    this.expire();
    const lines = [
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
      '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
      '',
      'Device ID        Local Intrfce   Holdtme    Capability   Platform     Port ID',
    ];
    const now = this.host.device.now;
    for (const n of this.neighbors.values()) {
      const hold = Math.max(0, Math.round((n.expires - now) / 1000));
      lines.push(`${n.deviceId.padEnd(17)}${shortName(n.port.name).padEnd(16)}${String(hold).padEnd(11)}${n.capabilities.padEnd(13)}${n.platform.padEnd(13)}${shortName(n.portId)}`);
    }
    return lines;
  }

  detail(): string[] {
    const out: string[] = [];
    for (const n of this.neighbors.values()) {
      out.push(
        '-------------------------',
        `Device ID: ${n.deviceId}`,
        'Entry address(es): ',
        ...(n.address ? [`  IP address : ${n.address}`] : []),
        `Platform: ${n.platform},  Capabilities: ${n.capabilities}`,
        `Interface: ${n.port.name},  Port ID (outgoing port): ${n.portId}`,
        `Holdtime : ${Math.max(0, Math.round((n.expires - this.host.device.now) / 1000))} sec`,
        '',
        'Version :',
        n.version,
        '',
        ...(n.nativeVlan !== undefined ? [`Native VLAN: ${n.nativeVlan}`] : []),
        ...(n.voiceVlan !== undefined ? [`Voice VLAN: ${n.voiceVlan}`] : []),
        'Duplex: full',
        '',
      );
    }
    return out;
  }
}

function shortName(n: string) {
  return n.replace('GigabitEthernet', 'Gig ').replace('FastEthernet', 'Fas ').replace('Ethernet', 'Eth ');
}
