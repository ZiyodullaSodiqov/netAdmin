// L3 interfeys — router porti, subinterfeys, SVI (interface Vlan), loopback yoki kompyuter NIC.
import type { Port } from './port';
import type { EthernetFrame } from './packets';
import { MAC, isValidIp, maskToPrefix, networkOf } from './util';

export type L3Kind = 'physical' | 'subif' | 'svi' | 'loopback' | 'host';

export interface DhcpClientState {
  state: 'INIT' | 'SELECTING' | 'REQUESTING' | 'BOUND' | 'RENEWING' | 'APIPA';
  xid: number;
  server?: string;
  leaseEnd?: number;
  offered?: string;
  retries: number;
  gateway?: string;
  dns?: string[];
  domain?: string;
  tftp?: string;
  lastError?: string;
}

export class L3Interface {
  name: string;
  kind: L3Kind;
  mac: MAC;
  ip: string | null = null;
  mask: string | null = null;
  adminUp = true;
  description = '';
  /** `ip address dhcp` yoki PC da DHCP rejimi */
  dhcp = false;
  dhcpState: DhcpClientState | null = null;
  /** Ushbu interfeysdan olingan DHCP default gateway */
  helpers: string[] = [];
  natRole: 'inside' | 'outside' | null = null;
  aclIn: string | null = null;
  aclOut: string | null = null;
  /** Subinterfeys: encapsulation dot1Q N [native] */
  encapVlan: number | null = null;
  encapNative = false;
  /** SVI uchun VLAN raqami */
  sviVlan: number | null = null;
  /** Fizik port (physical / subif / host) */
  port: Port | null;
  mtu = 1500;
  bandwidthKbps = 1_000_000;
  ospfCost: number | null = null;
  ospfPriority = 1;
  counters = { inPkts: 0, outPkts: 0, inBytes: 0, outBytes: 0 };
  /** L2 ga chiqarish */
  output: (frame: EthernetFrame) => void;
  /** Liniya protokoli holati */
  lineUp: () => boolean;

  constructor(opts: {
    name: string;
    kind: L3Kind;
    mac: MAC;
    port?: Port | null;
    output: (frame: EthernetFrame) => void;
    lineUp: () => boolean;
  }) {
    this.name = opts.name;
    this.kind = opts.kind;
    this.mac = opts.mac;
    this.port = opts.port ?? null;
    this.output = opts.output;
    this.lineUp = opts.lineUp;
  }

  /** Interfeys ishlayaptimi (admin up + line protocol up) */
  get up(): boolean {
    return this.adminUp && this.lineUp();
  }

  get hasIp(): boolean {
    return isValidIp(this.ip) && isValidIp(this.mask);
  }

  get network(): string | null {
    return this.hasIp ? networkOf(this.ip!, this.mask!) : null;
  }

  get prefix(): number {
    return this.mask ? maskToPrefix(this.mask) : 0;
  }

  get statusText() {
    if (!this.adminUp) return 'administratively down';
    return this.lineUp() ? 'up' : 'down';
  }
}
