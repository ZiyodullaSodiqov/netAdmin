// Cisco CallManager Express (telephony-service) — IP telefonlarni ro'yxatdan o'tkazish va qo'ng'iroqlarni boshqarish.
import type { IpStack } from '../ipstack';
import type { SccpMessage } from '../packets';
import type { TcpConn } from './tcp';
import { MAC } from '../util';

export interface EphoneDn {
  tag: number;
  number: string;
  name?: string;
  label?: string;
}

export interface Ephone {
  tag: number;
  mac: MAC | null;
  type: string;
  buttons: { button: number; dnTag: number }[];
  /** Ro'yxatdan o'tish holati */
  registered: boolean;
  ip?: string;
  conn?: TcpConn;
  lastSeen?: number;
  autoCreated?: boolean;
}

export interface CmeCall {
  id: number;
  from: Ephone;
  to: Ephone | null;
  fromNumber: string;
  toNumber: string;
  state: 'ringing' | 'connected' | 'ended';
  started: number;
  answered?: number;
}

let callIdCounter = 1;

function sccp(m: Omit<SccpMessage, 'kind' | 'size'>): SccpMessage {
  return { kind: 'sccp', size: 80 + (m.text?.length ?? 0), ...m };
}

export class CallManager {
  stack: IpStack;
  enabled = false;
  sourceIp: string | null = null;
  port = 2000;
  maxEphones = 0;
  maxDn = 0;
  autoAssign: { from: number; to: number } | null = null;
  autoRegEphone = true;
  dns = new Map<number, EphoneDn>();
  ephones = new Map<number, Ephone>();
  calls: CmeCall[] = [];
  log: string[] = [];

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  get active() {
    return this.enabled && !!this.sourceIp && this.stack.ownsIp(this.sourceIp);
  }

  reset() {
    this.enabled = false;
    this.sourceIp = null;
    this.port = 2000;
    this.maxEphones = 0;
    this.maxDn = 0;
    this.autoAssign = null;
    this.dns.clear();
    this.ephones.clear();
    this.calls = [];
    this.stack.tcp.unlisten(2000);
  }

  install() {
    this.stack.tcp.unlisten(this.port);
    if (!this.enabled) return;
    this.stack.tcp.listen(this.port, (c) => {
      if (!this.active || c.localIp !== this.sourceIp) return null;
      return {
        onData: (conn, msg) => {
          if (msg.kind === 'sccp') this.handle(conn, msg);
        },
        onClose: (conn) => {
          for (const e of this.ephones.values()) if (e.conn === conn) this.unregister(e);
        },
      };
    });
  }

  private logMsg(t: string) {
    this.log.push(t);
    if (this.log.length > 200) this.log.shift();
    this.stack.device.console(t);
  }

  private findEphoneByConn(c: TcpConn) {
    return [...this.ephones.values()].find((e) => e.conn === c);
  }

  private dnOf(e: Ephone): EphoneDn[] {
    return e.buttons.map((b) => this.dns.get(b.dnTag)).filter((x): x is EphoneDn => !!x);
  }

  private handle(conn: TcpConn, m: SccpMessage) {
    const dev = this.stack.device;
    switch (m.msg) {
      case 'Register': {
        let e = [...this.ephones.values()].find((x) => x.mac === m.mac);
        if (!e) {
          if (!this.autoRegEphone || this.ephones.size >= this.maxEphones) {
            conn.send(sccp({ msg: 'RegisterReject', reason: 'max-ephones oshib ketdi yoki ephone sozlanmagan' }));
            return;
          }
          let tag = 1;
          while (this.ephones.has(tag)) tag++;
          e = { tag, mac: m.mac!, type: m.model ?? '7960', buttons: [], registered: false, autoCreated: true };
          this.ephones.set(tag, e);
        }
        // auto assign: bo'sh DN lardan birini berish
        if (!e.buttons.length && this.autoAssign) {
          const used = new Set([...this.ephones.values()].flatMap((x) => x.buttons.map((b) => b.dnTag)));
          for (let t = this.autoAssign.from; t <= this.autoAssign.to; t++) {
            if (this.dns.has(t) && !used.has(t)) {
              e.buttons.push({ button: 1, dnTag: t });
              break;
            }
          }
        }
        e.registered = true;
        e.conn = conn;
        e.ip = conn.remoteIp;
        e.lastSeen = dev.now;
        const lines = this.dnOf(e).map((d) => ({ dn: d.number, label: d.label ?? d.name }));
        conn.send(sccp({ msg: 'RegisterAck', lines, deviceName: `SEP${(e.mac ?? '').replace(/:/g, '').toUpperCase()}` }));
        this.logMsg(`%IPPHONE-6-REGISTER: ephone-${e.tag} IP:${e.ip} Socket:1 DeviceType:Phone has registered.`);
        break;
      }
      case 'KeepAlive': {
        const e = this.findEphoneByConn(conn);
        if (e) e.lastSeen = dev.now;
        conn.send(sccp({ msg: 'KeepAliveAck' }));
        break;
      }
      case 'Dial': {
        const from = this.findEphoneByConn(conn);
        if (!from) return;
        const fromDn = this.dnOf(from)[0];
        const target = [...this.dns.values()].find((d) => d.number === m.dialed);
        if (!target) {
          conn.send(sccp({ msg: 'CallState', state: 'unknown-number', remoteNumber: m.dialed }));
          return;
        }
        const to = [...this.ephones.values()].find((e) => e.registered && e.buttons.some((b) => b.dnTag === target.tag));
        if (!to || to === from) {
          conn.send(sccp({ msg: 'CallState', state: to === from ? 'busy' : 'unknown-number', remoteNumber: m.dialed }));
          return;
        }
        const busy = this.calls.some((c) => c.state !== 'ended' && (c.from === to || c.to === to));
        if (busy) {
          conn.send(sccp({ msg: 'CallState', state: 'busy', remoteNumber: m.dialed }));
          return;
        }
        const call: CmeCall = { id: callIdCounter++, from, to, fromNumber: fromDn?.number ?? '?', toNumber: target.number, state: 'ringing', started: dev.now };
        this.calls.push(call);
        conn.send(sccp({ msg: 'CallState', state: 'ringout', remoteNumber: target.number, callId: call.id }));
        to.conn?.send(sccp({ msg: 'CallState', state: 'ringing', remoteNumber: call.fromNumber, callId: call.id }));
        break;
      }
      case 'Answer': {
        const call = this.calls.find((c) => c.id === m.callId && c.state === 'ringing');
        if (!call || !call.to) return;
        call.state = 'connected';
        call.answered = dev.now;
        const a = call.from;
        const b = call.to;
        const portA = 16384 + (call.id % 1000) * 2;
        const portB = 16384 + (call.id % 1000) * 2 + 2000;
        a.conn?.send(sccp({ msg: 'StartMedia', callId: call.id, remoteIp: b.ip, remotePort: portB, localPort: portA, codec: 'G.711' }));
        b.conn?.send(sccp({ msg: 'StartMedia', callId: call.id, remoteIp: a.ip, remotePort: portA, localPort: portB, codec: 'G.711' }));
        a.conn?.send(sccp({ msg: 'CallState', state: 'connected', callId: call.id, remoteNumber: call.toNumber }));
        b.conn?.send(sccp({ msg: 'CallState', state: 'connected', callId: call.id, remoteNumber: call.fromNumber }));
        break;
      }
      case 'OnHook': {
        const e = this.findEphoneByConn(conn);
        if (!e) return;
        for (const call of this.calls) {
          if (call.state === 'ended' || (call.from !== e && call.to !== e)) continue;
          call.state = 'ended';
          const other = call.from === e ? call.to : call.from;
          for (const p of [call.from, call.to]) p?.conn?.send(sccp({ msg: 'StopMedia', callId: call.id }));
          other?.conn?.send(sccp({ msg: 'CallState', state: 'hangup', callId: call.id }));
        }
        this.calls = this.calls.filter((c) => c.state !== 'ended' || dev.now - c.started < 600_000);
        break;
      }
    }
  }

  private unregister(e: Ephone) {
    if (!e.registered) return;
    e.registered = false;
    e.conn = undefined;
    this.logMsg(`%IPPHONE-6-UNREGISTER_NORMAL: ephone-${e.tag}:SEP${(e.mac ?? '').replace(/:/g, '').toUpperCase()} IP:${e.ip} Socket:1 DeviceType:Phone has unregistered normally.`);
    for (const call of this.calls) {
      if (call.state !== 'ended' && (call.from === e || call.to === e)) {
        call.state = 'ended';
        const other = call.from === e ? call.to : call.from;
        other?.conn?.send(sccp({ msg: 'StopMedia', callId: call.id }));
        other?.conn?.send(sccp({ msg: 'CallState', state: 'hangup', callId: call.id }));
      }
    }
  }

  tick() {
    const now = this.stack.device.now;
    for (const e of this.ephones.values()) if (e.registered && e.lastSeen && now - e.lastSeen > 90_000) this.unregister(e);
  }

  /** show ephone */
  ephoneText(): string[] {
    const out: string[] = [];
    for (const e of [...this.ephones.values()].sort((a, b) => a.tag - b.tag)) {
      out.push(`ephone-${e.tag}[${e.tag - 1}] Mac:${(e.mac ?? '0000.0000.0000').replace(/:/g, '').replace(/(.{4})(.{4})(.{4})/, '$1.$2.$3').toUpperCase()} TCP socket:[${e.registered ? 1 : -1}] activeLine:0 whisperLine:0 ${e.registered ? 'REGISTERED' : 'UNREGISTERED'} in SCCP ver 12/12 max_streams=5`);
      out.push(`mediaActive:0 whisper_mediaActive:0 startMedia:0 offhook:0 ringing:0 reset:0 reset_sent:0 paging 0 debug:0 caps:8`);
      out.push(`IP:${e.ip ?? '0.0.0.0'} * ${e.type}  keepalive ${e.registered ? 30 : 0} max_line 2 available_line 2`);
      for (const b of e.buttons) {
        const dn = this.dns.get(b.dnTag);
        if (dn) out.push(`button ${b.button}: cw:1 ccw:(0 0)\n  dn ${dn.tag}  number ${dn.number} CH1   IDLE         CH2   IDLE`);
      }
      out.push('');
    }
    return out;
  }
}
