// Spanning Tree Protocol — PVST+ (802.1D) va Rapid-PVST+ (802.1w, soddalashtirilgan).
// Haqiqiy BPDU almashinuvi, root saylovi, port rollari, listening/learning taymerlari.
import type { Port } from '../port';
import type { Bpdu, EthernetFrame } from '../packets';
import { nextFrameId } from '../packets';
import { MAC, STP_MCAST_MAC, PVST_MCAST_MAC } from '../util';
import type { SwitchFabric } from '../switching';

export type StpRole = 'root' | 'designated' | 'alternate' | 'backup' | 'disabled';
export type StpState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'disabled';

interface Vector {
  rootPrio: number;
  rootMac: MAC;
  cost: number;
  bridgePrio: number;
  bridgeMac: MAC;
  portId: number;
}

function cmp(a: Vector, b: Vector): number {
  if (a.rootPrio !== b.rootPrio) return a.rootPrio - b.rootPrio;
  if (a.rootMac !== b.rootMac) return a.rootMac < b.rootMac ? -1 : 1;
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.bridgePrio !== b.bridgePrio) return a.bridgePrio - b.bridgePrio;
  if (a.bridgeMac !== b.bridgeMac) return a.bridgeMac < b.bridgeMac ? -1 : 1;
  return a.portId - b.portId;
}

export interface StpPortInfo {
  role: StpRole;
  state: StpState;
  info: (Vector & { received: number; messageAge: number }) | null;
  timer: any;
  edge: boolean;
}

export function stpCostForSpeed(mbps: number): number {
  if (mbps >= 10000) return 2;
  if (mbps >= 1000) return 4;
  if (mbps >= 100) return 19;
  return 100;
}

export class StpInstance {
  vlan: number;
  mgr: StpManager;
  priority = 32768;
  rootPrio = 0;
  rootMac: MAC = '';
  rootCost = 0;
  rootPort: Port | null = null;
  ports = new Map<Port, StpPortInfo>();
  tcUntil = 0;
  topologyChanges = 0;
  lastTc = 0;

  constructor(mgr: StpManager, vlan: number) {
    this.mgr = mgr;
    this.vlan = vlan;
  }

  get bridgePrio() {
    return this.priority + this.vlan;
  }

  get bridgeMac() {
    return this.mgr.fabric.baseMac;
  }

  get isRoot() {
    return this.rootPort === null;
  }

  portId(p: Port) {
    const idx = this.mgr.fabric.ports.indexOf(p) + 1;
    return ((p.switchport?.stpPortPriority ?? 128) << 8) | idx;
  }

  portCost(p: Port) {
    return p.switchport?.stpCost ?? stpCostForSpeed(p.operSpeed || p.maxSpeed);
  }

  info(p: Port): StpPortInfo {
    let i = this.ports.get(p);
    if (!i) {
      i = { role: 'disabled', state: 'disabled', info: null, timer: null, edge: false };
      this.ports.set(p, i);
    }
    return i;
  }

  /** Port rollari va root ni qayta hisoblash */
  recompute() {
    const f = this.mgr.fabric;
    const members = f.ports.filter((p) => p.operUp && f.portCarriesVlan(p, this.vlan));
    // a'zo bo'lmagan portlar — disabled
    for (const [p, i] of this.ports) {
      if (!members.includes(p)) {
        if (i.state !== 'disabled') this.setState(p, i, 'disabled');
        i.role = 'disabled';
        i.info = null;
      }
    }
    const own: Vector = { rootPrio: this.bridgePrio, rootMac: this.bridgeMac, cost: 0, bridgePrio: this.bridgePrio, bridgeMac: this.bridgeMac, portId: 0 };
    let best = own;
    let bestPort: Port | null = null;
    for (const p of members) {
      const i = this.info(p);
      if (!i.info) continue;
      const cand: Vector = { rootPrio: i.info.rootPrio, rootMac: i.info.rootMac, cost: i.info.cost + this.portCost(p), bridgePrio: i.info.bridgePrio, bridgeMac: i.info.bridgeMac, portId: i.info.portId };
      const c = cmp(cand, best);
      if (c < 0 || (c === 0 && bestPort && this.portId(p) < this.portId(bestPort))) {
        best = cand;
        bestPort = p;
      }
    }
    const oldRoot = this.rootMac;
    this.rootPrio = best.rootPrio;
    this.rootMac = best.rootMac;
    this.rootCost = bestPort ? best.cost : 0;
    this.rootPort = bestPort;
    if (oldRoot && oldRoot !== this.rootMac && this.mgr.fabric.device.powered) {
      if (this.isRoot) this.mgr.fabric.device.syslog('SPANTREE', 5, 'ROOTCHANGE', `Root Changed for vlan ${this.vlan}: New Root Port is None. This bridge is the root.`);
    }
    for (const p of members) {
      const i = this.info(p);
      let role: StpRole;
      if (p === bestPort) role = 'root';
      else {
        const mine: Vector = { rootPrio: this.rootPrio, rootMac: this.rootMac, cost: this.rootCost, bridgePrio: this.bridgePrio, bridgeMac: this.bridgeMac, portId: this.portId(p) };
        if (!i.info || cmp(mine, i.info) < 0) role = 'designated';
        else role = i.info.bridgeMac === this.bridgeMac ? 'backup' : 'alternate';
      }
      this.applyRole(p, i, role);
    }
  }

  private applyRole(p: Port, i: StpPortInfo, role: StpRole) {
    const prev = i.role;
    i.role = role;
    i.edge = !!p.switchport?.portfast;
    const rapid = this.mgr.mode === 'rapid-pvst';
    if (role === 'alternate' || role === 'backup') {
      if (i.state !== 'blocking') this.setState(p, i, 'blocking');
      return;
    }
    // root / designated
    if (i.state === 'forwarding') return;
    if (i.edge) {
      this.setState(p, i, 'forwarding');
      return;
    }
    if (i.state === 'disabled' || i.state === 'blocking') {
      if (rapid) {
        // RSTP: proposal/agreement — deyarli bir zumda (root port darhol)
        this.setState(p, i, role === 'root' ? 'forwarding' : 'learning');
        if (role !== 'root') {
          this.clearTimer(i);
          i.timer = this.mgr.fabric.device.setTimer(50, () => {
            if (i.role === 'root' || i.role === 'designated') this.setState(p, i, 'forwarding');
          });
        }
        return;
      }
      this.setState(p, i, 'listening');
      this.clearTimer(i);
      const fd = this.mgr.forwardDelay * 1000;
      i.timer = this.mgr.fabric.device.setTimer(fd, () => {
        if (i.role !== 'root' && i.role !== 'designated') return;
        this.setState(p, i, 'learning');
        i.timer = this.mgr.fabric.device.setTimer(fd, () => {
          if (i.role !== 'root' && i.role !== 'designated') return;
          this.setState(p, i, 'forwarding');
        });
      });
    } else if (prev !== role && rapid && i.state === 'learning') {
      this.setState(p, i, 'forwarding');
    }
  }

  private clearTimer(i: StpPortInfo) {
    if (i.timer) this.mgr.fabric.device.clearTimer(i.timer);
    i.timer = null;
  }

  private setState(p: Port, i: StpPortInfo, s: StpState) {
    const old = i.state;
    if (old === s) return;
    if (s === 'blocking' || s === 'disabled') this.clearTimer(i);
    i.state = s;
    const f = this.mgr.fabric;
    if ((s === 'forwarding' && !i.edge) || (old === 'forwarding' && s !== 'disabled')) this.topologyChange();
    if (old === 'forwarding' && s !== 'forwarding') f.flushPort(p, this.vlan);
    f.device.net.bump();
  }

  topologyChange() {
    const now = this.mgr.fabric.device.now;
    this.topologyChanges++;
    this.lastTc = now;
    this.tcUntil = now + (this.mgr.maxAge + this.mgr.forwardDelay) * 1000;
    this.mgr.fabric.flushVlan(this.vlan, true);
  }

  /** Designated portlarga BPDU yuborish */
  sendHellos() {
    const f = this.mgr.fabric;
    const tc = this.tcUntil > f.device.now;
    for (const [p, i] of this.ports) {
      if (i.role !== 'designated' || !p.operUp) continue;
      this.sendBpdu(p, tc);
    }
  }

  sendBpdu(p: Port, tc = this.tcUntil > this.mgr.fabric.device.now) {
    const f = this.mgr.fabric;
    const b: Bpdu = {
      kind: 'bpdu',
      vlan: this.vlan,
      rootPriority: this.rootPrio,
      rootMac: this.rootMac,
      rootCost: this.rootCost,
      bridgePriority: this.bridgePrio,
      bridgeMac: this.bridgeMac,
      portId: this.portId(p),
      messageAge: this.isRoot ? 0 : 1,
      maxAge: this.mgr.maxAge,
      helloTime: this.mgr.helloTime,
      forwardDelay: this.mgr.forwardDelay,
      tc,
      tca: false,
      rstp: this.mgr.mode === 'rapid-pvst',
    };
    const frame: EthernetFrame = { id: nextFrameId(), src: p.mac, dst: this.vlan === 1 ? STP_MCAST_MAC : PVST_MCAST_MAC, etherType: 'STP', payload: b };
    f.egressControl(p, this.vlan, frame);
  }

  receive(p: Port, b: Bpdu) {
    const i = this.info(p);
    const now = this.mgr.fabric.device.now;
    const v: Vector = { rootPrio: b.rootPriority, rootMac: b.rootMac, cost: b.rootCost, bridgePrio: b.bridgePriority, bridgeMac: b.bridgeMac, portId: b.portId };
    const sameSender = i.info && i.info.bridgeMac === v.bridgeMac && i.info.portId === v.portId;
    if (!i.info || cmp(v, i.info) < 0 || sameSender) {
      const changed = !i.info || cmp(v, i.info) !== 0;
      i.info = { ...v, received: now, messageAge: b.messageAge };
      if (changed) this.recompute();
    } else if (i.role === 'designated') {
      // yomonroq BPDU keldi — darhol o'zimiznikini yuboramiz
      this.sendBpdu(p);
    }
    if (b.tc && now - this.lastTc > 2000) {
      this.lastTc = now;
      this.tcUntil = now + (this.mgr.maxAge + this.mgr.forwardDelay) * 1000;
      this.mgr.fabric.flushVlan(this.vlan, true);
    }
  }

  ageInfo() {
    const now = this.mgr.fabric.device.now;
    const maxAgeMs = (this.mgr.mode === 'rapid-pvst' ? 3 * this.mgr.helloTime : this.mgr.maxAge) * 1000;
    let changed = false;
    for (const i of this.ports.values()) {
      if (i.info && now - i.info.received > maxAgeMs) {
        i.info = null;
        changed = true;
      }
    }
    if (changed) this.recompute();
  }

  canForward(p: Port) {
    const i = this.ports.get(p);
    return !!i && i.state === 'forwarding';
  }

  canLearn(p: Port) {
    const i = this.ports.get(p);
    return !!i && (i.state === 'forwarding' || i.state === 'learning');
  }
}

export class StpManager {
  fabric: SwitchFabric;
  enabled = true;
  mode: 'pvst' | 'rapid-pvst' = 'pvst';
  helloTime = 2;
  maxAge = 20;
  forwardDelay = 15;
  instances = new Map<number, StpInstance>();
  /** VLAN bo'yicha STP o'chirilgan (no spanning-tree vlan X) */
  disabledVlans = new Set<number>();
  priorities = new Map<number, number>();
  portfastDefault = false;
  bpduGuardDefault = false;
  private stopHello: (() => void) | null = null;

  constructor(fabric: SwitchFabric) {
    this.fabric = fabric;
  }

  start() {
    this.stopHello?.();
    this.stopHello = this.fabric.device.every(this.helloTime * 1000, () => {
      for (const inst of this.instances.values()) {
        inst.ageInfo();
        inst.sendHellos();
      }
    }, 100);
  }

  stop() {
    this.stopHello?.();
    this.stopHello = null;
    this.instances.clear();
  }

  /** VLAN ro'yxati yoki port holati o'zgarganda */
  sync() {
    if (!this.enabled) {
      this.instances.clear();
      return;
    }
    const vlans = [...this.fabric.vlans.keys()].filter((v) => v < 1002 && !this.disabledVlans.has(v));
    for (const v of vlans) {
      if (!this.instances.has(v)) {
        const inst = new StpInstance(this, v);
        this.instances.set(v, inst);
      }
      const inst = this.instances.get(v)!;
      inst.priority = this.priorities.get(v) ?? 32768;
    }
    for (const v of [...this.instances.keys()]) if (!vlans.includes(v)) this.instances.delete(v);
    for (const inst of this.instances.values()) inst.recompute();
    // yangi designated portlarga darhol BPDU
    for (const inst of this.instances.values()) inst.sendHellos();
  }

  receive(p: Port, vlan: number, b: Bpdu) {
    if (!this.enabled) return;
    if (p.switchport?.bpduGuard || (this.bpduGuardDefault && p.switchport?.portfast)) {
      if (p.switchport?.portfast || p.switchport?.bpduGuard) {
        this.fabric.errDisable(p, 'bpduguard');
        return;
      }
    }
    const inst = this.instances.get(vlan);
    if (inst) inst.receive(p, b);
  }

  canForward(p: Port, vlan: number) {
    if (!this.enabled || this.disabledVlans.has(vlan)) return true;
    const inst = this.instances.get(vlan);
    if (!inst) return true;
    return inst.canForward(p);
  }

  canLearn(p: Port, vlan: number) {
    if (!this.enabled || this.disabledVlans.has(vlan)) return true;
    const inst = this.instances.get(vlan);
    if (!inst) return true;
    return inst.canLearn(p);
  }

  /** LED rangi uchun: port biror VLAN da forwarding holatidami */
  portState(p: Port): StpState {
    if (!this.enabled) return p.operUp ? 'forwarding' : 'disabled';
    let best: StpState = 'disabled';
    const rank: Record<StpState, number> = { disabled: 0, blocking: 1, listening: 2, learning: 3, forwarding: 4 };
    for (const inst of this.instances.values()) {
      const i = inst.ports.get(p);
      if (i && rank[i.state] > rank[best]) best = i.state;
    }
    if (best === 'disabled' && p.operUp && this.instances.size === 0) return 'forwarding';
    return best;
  }
}
