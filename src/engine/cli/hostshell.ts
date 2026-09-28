// Kompyuter buyruqlar qatori: Windows (cmd) va Linux (bash) uslubida.
import type { Host } from '../devices/host';
import { OutputBus, TerminalSession } from './terminal';
import { pingOnce, traceroute, newIdent } from './apps';
import { openRemoteTerminal } from './remote';
import { httpFetch } from '../devices/host-apps';
import { isValidIp, macWindows, formatUptime, padRight } from '../util';
import type { NetOsDevice } from '../devices/netos';
import { IosCli } from './ios';

export class HostShell implements TerminalSession {
  host: Host;
  out = new OutputBus();
  history: string[] = [];
  private busy: { cancel: () => void } | null = null;
  private remote: TerminalSession | null = null;
  private closeFns: (() => void)[] = [];

  constructor(host: Host) {
    this.host = host;
    if (host.os === 'windows') {
      this.print('');
      this.print('Microsoft Windows [Version 10.0.19045.3803]');
      this.print('(c) Microsoft Corporation. All rights reserved.');
      this.print('');
    } else {
      this.print(`Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-101-generic x86_64)`);
      this.print('');
    }
    this.writePrompt();
  }

  get win() {
    return this.host.os === 'windows';
  }

  prompt() {
    if (this.remote) return this.remote.prompt();
    return this.win ? 'C:\\>' : `root@${this.host.label.toLowerCase().replace(/\s+/g, '-')}:~# `;
  }

  print(t = '') {
    this.out.line(t);
  }

  private writePrompt() {
    this.out.write(this.prompt());
  }

  onOutput(fn: (t: string) => void) {
    const b = this.out.buffer.splice(0);
    const u = this.out.on(fn);
    for (const x of b) fn(x);
    return u;
  }

  onClose(fn: () => void) {
    this.closeFns.push(fn);
  }

  close() {
    this.busy?.cancel();
    this.remote?.close?.();
    for (const f of this.closeFns) f();
  }

  isSecret() {
    return this.remote?.isSecret?.() ?? false;
  }

  isBusy() {
    return !!this.busy;
  }

  interrupt() {
    if (this.remote) {
      this.remote.interrupt?.();
      return;
    }
    if (this.busy) {
      this.busy.cancel();
      this.busy = null;
      this.print('^C');
      this.writePrompt();
    }
  }

  complete(line: string): string | null {
    if (this.remote) return this.remote.complete?.(line) ?? null;
    const cmds = this.win ? ['ipconfig', 'ping', 'tracert', 'arp', 'nslookup', 'netstat', 'telnet', 'ssh', 'hostname', 'cls', 'help', 'route', 'getmac', 'curl'] : ['ip', 'ifconfig', 'ping', 'traceroute', 'arp', 'nslookup', 'dig', 'netstat', 'ss', 'curl', 'top', 'uptime', 'hostname', 'clear', 'ssh', 'telnet'];
    const m = cmds.filter((c) => c.startsWith(line.trim()));
    return m.length === 1 ? m[0] + ' ' : null;
  }

  private run(cancel: () => void) {
    this.busy = { cancel };
  }

  private done() {
    this.busy = null;
    if (!this.remote) this.writePrompt();
  }

  input(line: string) {
    if (this.remote) {
      this.remote.input(line);
      return;
    }
    if (this.busy) return;
    this.out.write(line + '\n');
    const t = line.trim();
    if (t) this.history.push(t);
    if (!t) {
      this.writePrompt();
      return;
    }
    const [cmd0, ...args] = t.split(/\s+/);
    const cmd = cmd0.toLowerCase();
    if (!this.host.powered) return;
    const fn = (this.win ? WIN : LINUX)[cmd] ?? COMMON[cmd];
    if (!fn) {
      if (this.win) this.print(`'${cmd0}' is not recognized as an internal or external command,\noperable program or batch file.`);
      else this.print(`${cmd0}: command not found`);
      this.print('');
      this.writePrompt();
      return;
    }
    const async = fn(this, args);
    if (!async) {
      if (this.win) this.print('');
      this.writePrompt();
    }
  }

  // --------------------------------------------------------------- ping
  ping(args: string[]) {
    const h = this.host;
    let count = this.win ? 4 : 4;
    let size = this.win ? 32 : 56;
    let forever = false;
    let target = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t') forever = true;
      else if (a === '-n' || a === '-c') count = Number(args[++i]) || 4;
      else if (a === '-l' || a === '-s') size = Number(args[++i]) || size;
      else target = a;
    }
    if (!target) {
      this.print(this.win ? '\nUsage: ping [-t] [-n count] [-l size] target_name' : 'ping: usage error: Destination address required');
      return false;
    }
    let cancelled = false;
    this.run(() => (cancelled = true));
    h.resolver.resolve(target, (ip) => {
      if (cancelled) return;
      if (!ip) {
        this.print(this.win ? `Ping request could not find host ${target}. Please check the name and try again.` : `ping: ${target}: Name or service not known`);
        this.done();
        return;
      }
      if (this.win) this.print(`\nPinging ${target !== ip ? `${target} [${ip}]` : ip} with ${size} bytes of data:\n`);
      else this.print(`PING ${target} (${ip}) ${size}(${size + 28}) bytes of data.`);
      let seq = 0;
      let recv = 0;
      const rtts: number[] = [];
      const ident = newIdent();
      const finish = () => {
        const sent = seq;
        if (this.win) {
          this.print(`\nPing statistics for ${ip}:`);
          this.print(`    Packets: Sent = ${sent}, Received = ${recv}, Lost = ${sent - recv} (${sent ? Math.round(((sent - recv) / sent) * 100) : 0}% loss),`);
          if (rtts.length) {
            this.print('Approximate round trip times in milli-seconds:');
            this.print(`    Minimum = ${Math.round(Math.min(...rtts))}ms, Maximum = ${Math.round(Math.max(...rtts))}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}ms`);
          }
          this.print('');
        } else {
          this.print('');
          this.print(`--- ${target} ping statistics ---`);
          this.print(`${sent} packets transmitted, ${recv} received, ${sent ? Math.round(((sent - recv) / sent) * 100) : 0}% packet loss, time ${sent * 1000}ms`);
          if (rtts.length) this.print(`rtt min/avg/max/mdev = ${Math.min(...rtts).toFixed(3)}/${(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3)}/${Math.max(...rtts).toFixed(3)}/0.100 ms`);
        }
        this.done();
      };
      this.busy = {
        cancel: () => {
          cancelled = true;
          finish();
        },
      };
      const next = () => {
        if (cancelled) return;
        if (!forever && seq >= count) return finish();
        const s = seq++;
        pingOnce(h, h.stack, ip, { ident, seq: s, size, timeoutMs: this.win ? 4000 : 2000 }, (r) => {
          if (cancelled) return;
          let wait = 1000;
          switch (r.kind) {
            case 'reply': {
              recv++;
              rtts.push(r.rtt);
              const t = r.rtt < 1 ? (this.win ? 'time<1ms' : `time=${r.rtt.toFixed(3)} ms`) : this.win ? `time=${Math.round(r.rtt)}ms` : `time=${r.rtt.toFixed(1)} ms`;
              this.print(this.win ? `Reply from ${r.from}: bytes=${r.bytes} ${t} TTL=${r.ttl}` : `${size + 8} bytes from ${r.from}: icmp_seq=${s + 1} ttl=${r.ttl} ${t}`);
              wait = Math.max(0, 1000 - r.rtt);
              break;
            }
            case 'timeout':
              this.print(this.win ? 'Request timed out.' : '');
              wait = 0;
              break;
            case 'unreachable':
              this.print(this.win ? `Reply from ${r.from}: Destination host unreachable.` : `From ${r.from} icmp_seq=${s + 1} Destination Host Unreachable`);
              break;
            case 'ttl-exceeded':
              this.print(this.win ? `Reply from ${r.from}: TTL expired in transit.` : `From ${r.from} icmp_seq=${s + 1} Time to live exceeded`);
              break;
            case 'no-route':
              this.print(this.win ? 'PING: transmit failed. General failure. ' : 'ping: connect: Network is unreachable');
              wait = 1000;
              break;
          }
          h.setTimer(wait, next);
        });
      };
      next();
    });
    return true;
  }

  tracert(args: string[]) {
    const h = this.host;
    const target = args.filter((a) => !a.startsWith('-'))[0];
    if (!target) {
      this.print('Usage: tracert target_name');
      return false;
    }
    let cancel = () => {};
    this.run(() => cancel());
    h.resolver.resolve(target, (ip) => {
      if (!ip) {
        this.print(`Unable to resolve target system name ${target}.`);
        this.done();
        return;
      }
      if (this.win) this.print(`\nTracing route to ${target !== ip ? `${target} [${ip}]` : ip}\nover a maximum of 30 hops:\n`);
      else this.print(`traceroute to ${target} (${ip}), 30 hops max, 60 byte packets`);
      cancel = traceroute(
        h,
        h.stack,
        ip,
        { mode: this.win ? 'icmp' : 'udp', maxHops: 30, probes: 3, timeoutMs: this.win ? 4000 : 3000 },
        (hop) => {
          if (this.win) {
            const cols = hop.probes.map((p) => (p ? (p.rtt < 1 ? '<1 ms' : `${Math.round(p.rtt)} ms`).padStart(6) : '     *')).join('  ');
            const from = hop.probes.find((p) => p)?.from;
            this.print(`${String(hop.ttl).padStart(3)}  ${cols}  ${from ?? 'Request timed out.'}`);
          } else {
            const from = hop.probes.find((p) => p)?.from;
            this.print(`${String(hop.ttl).padStart(2)}  ${from ? `${from} (${from})` : ''}  ${hop.probes.map((p) => (p ? `${p.rtt.toFixed(3)} ms` : '*')).join('  ')}`);
          }
        },
        () => {
          if (this.win) this.print('\nTrace complete.\n');
          this.done();
        },
      );
    });
    return true;
  }

  ipconfig(args: string[]) {
    const h = this.host;
    const flag = (args[0] ?? '').toLowerCase();
    if (flag === '/release') {
      for (const n of h.nics) if (n.cfg.mode === 'dhcp') n.dhcp.release();
      h.updateGateway();
      this.showIpconfig(false);
      return false;
    }
    if (flag === '/renew') {
      const dhcpNics = h.nics.filter((n) => n.cfg.mode === 'dhcp' && n.port.operUp);
      if (!dhcpNics.length) {
        this.print('\nAn error occurred while renewing interface FastEthernet0 : The DHCP service is not enabled on this adapter or media is disconnected.');
        return false;
      }
      this.run(() => {});
      let left = dhcpNics.length;
      for (const n of dhcpNics)
        n.dhcp.start((ok) => {
          if (!ok) this.print(`\nAn error occurred while renewing interface ${n.port.name} : unable to contact your DHCP server. Request has timed out.`);
          if (--left === 0) {
            this.showIpconfig(false);
            this.print('');
            this.done();
          }
        });
      return true;
    }
    if (flag === '/flushdns') {
      h.resolver.flush();
      this.print('\nWindows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.');
      return false;
    }
    this.showIpconfig(flag === '/all');
    return false;
  }

  private showIpconfig(all: boolean) {
    const h = this.host;
    this.print('\nWindows IP Configuration\n');
    if (all) {
      this.print(`   Host Name . . . . . . . . . . . . : ${h.label}`);
      this.print(`   Primary Dns Suffix  . . . . . . . : `);
      this.print(`   Node Type . . . . . . . . . . . . : Hybrid`);
      this.print(`   IP Routing Enabled. . . . . . . . : No`);
      this.print('');
    }
    for (const n of h.nics) {
      const wl = n.port.media === 'wireless';
      this.print(`\n${wl ? 'Wireless LAN' : 'Ethernet'} adapter ${n.port.name}:\n`);
      if (!n.port.operUp) {
        this.print('   Media State . . . . . . . . . . . : Media disconnected');
        this.print('   Connection-specific DNS Suffix  . : ');
        if (all) this.print(`   Physical Address. . . . . . . . . : ${macWindows(n.port.mac)}`);
        continue;
      }
      const st = n.iface.dhcpState;
      this.print(`   Connection-specific DNS Suffix  . : ${st?.domain ?? ''}`);
      if (all) {
        this.print(`   Description . . . . . . . . . . . : ${wl ? 'Intel(R) Wi-Fi 6 AX201' : 'Intel(R) Ethernet Connection I219-V'}`);
        this.print(`   Physical Address. . . . . . . . . : ${macWindows(n.port.mac)}`);
        this.print(`   DHCP Enabled. . . . . . . . . . . : ${n.cfg.mode === 'dhcp' ? 'Yes' : 'No'}`);
        this.print(`   Autoconfiguration Enabled . . . . : Yes`);
      }
      const m = n.port.mac.split(':');
      this.print(`   Link-local IPv6 Address . . . . . : fe80::${m[0]}${m[1]}:${m[2]}ff:fe${m[3]}:${m[4]}${m[5]}%12`);
      if (n.iface.ip) {
        const apipa = st?.state === 'APIPA';
        this.print(`   ${apipa ? 'Autoconfiguration IPv4 Address' : 'IPv4 Address'}. . . . . . . . . . . : ${n.iface.ip}${all ? '(Preferred)' : ''}`.replace('Autoconfiguration IPv4 Address. . . . . . . . . . .', 'Autoconfiguration IPv4 Address. .'));
        this.print(`   Subnet Mask . . . . . . . . . . . : ${n.iface.mask}`);
      }
      if (all && st?.state === 'BOUND') {
        this.print(`   Lease Obtained. . . . . . . . . . : ${new Date(Date.now() - 60000).toLocaleString('en-US')}`);
        this.print(`   Lease Expires . . . . . . . . . . : ${new Date(Date.now() + 86400000).toLocaleString('en-US')}`);
      }
      this.print(`   Default Gateway . . . . . . . . . : ${h.stack.defaultGateway && n.iface.hasIp ? h.stack.defaultGateway : ''}`);
      if (all) {
        if (st?.server) this.print(`   DHCP Server . . . . . . . . . . . : ${st.server}`);
        this.print(`   DNS Servers . . . . . . . . . . . : ${h.stack.dnsServers.join('\n                                       ') || ''}`);
        this.print(`   NetBIOS over Tcpip. . . . . . . . : Enabled`);
      }
    }
  }

  arp(args: string[]) {
    const h = this.host;
    if (args[0] === '-d') {
      h.stack.arp.clear();
      return false;
    }
    if (this.win) {
      for (const n of h.nics) {
        if (!n.iface.ip) continue;
        const entries = [...h.stack.arp.entries()].filter(([, e]) => e.iface === n.iface && e.expires > h.now);
        this.print(`\nInterface: ${n.iface.ip} --- 0x${(h.nics.indexOf(n) + 11).toString(16)}`);
        if (!entries.length) {
          this.print('No ARP Entries Found');
          continue;
        }
        this.print('  Internet Address      Physical Address      Type');
        for (const [ip, e] of entries) this.print(`  ${padRight(ip, 22)}${padRight(macWindows(e.mac).toLowerCase(), 22)}dynamic`);
      }
      if (!h.stack.arp.size && !h.nics.some((n) => n.iface.ip)) this.print('No ARP Entries Found');
    } else {
      this.print('Address                  HWtype  HWaddress           Flags Mask            Iface');
      for (const [ip, e] of h.stack.arp) if (e.expires > h.now) this.print(`${padRight(ip, 25)}ether   ${padRight(e.mac, 20)}C                     ${e.iface.name.toLowerCase()}`);
    }
    return false;
  }

  nslookup(args: string[]) {
    const h = this.host;
    const name = args[args.length - 1];
    const srv = h.stack.dnsServers[0];
    if (!name) {
      this.print(`Default Server:  UnKnown\nAddress:  ${srv ?? '127.0.0.1'}`);
      return false;
    }
    this.run(() => {});
    h.resolver.resolve(name, (ip, err) => {
      this.print(`Server:  UnKnown`);
      this.print(`Address:  ${srv ?? '(none)'}`);
      this.print('');
      if (ip) {
        this.print('Non-authoritative answer:');
        this.print(`Name:    ${name}`);
        this.print(`Address:  ${ip}`);
      } else if (err === 'NXDOMAIN') this.print(`*** UnKnown can't find ${name}: Non-existent domain`);
      else this.print(`DNS request timed out.\n    timeout was 2 seconds.\n*** Request to UnKnown timed-out`);
      this.print('');
      this.done();
    });
    return true;
  }

  netstat() {
    const h = this.host;
    this.print('\nActive Connections\n');
    this.print('  Proto  Local Address          Foreign Address        State');
    for (const c of h.stack.tcp.conns.values()) this.print(`  TCP    ${padRight(`${c.localIp}:${c.localPort}`, 23)}${padRight(`${c.remoteIp}:${c.remotePort}`, 23)}${c.state === 'ESTABLISHED' ? 'ESTABLISHED' : c.state}`);
    return false;
  }

  remoteLogin(proto: 'telnet' | 'ssh', args: string[]) {
    const h = this.host;
    let user: string | undefined;
    let target = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l') user = args[++i];
      else if (args[i].includes('@')) [user, target] = args[i].split('@');
      else target = args[i];
    }
    if (!target) {
      this.print(proto === 'ssh' ? 'Usage: SSH -l username target' : 'Usage: telnet target');
      return false;
    }
    if (proto === 'ssh' && !user) {
      this.print('Usage: SSH -l username target');
      return false;
    }
    this.print(proto === 'telnet' ? `Trying ${target} ...Open` : '');
    this.run(() => {});
    openRemoteTerminal(h, h.stack, h.resolver, target, proto, user, {
      onOpen: (sess) => {
        this.busy = null;
        this.remote = sess;
        const un = sess.onOutput((t) => this.out.write(t));
        sess.onClose?.(() => {
          un();
          this.remote = null;
          this.print('');
          this.print('[Connection to ' + target + ' closed by foreign host]');
          this.writePrompt();
        });
      },
      onError: (msg) => {
        this.print(msg.replace('% ', '% '));
        this.print('');
        this.done();
      },
    });
    return true;
  }

  curl(args: string[]) {
    const url = args.filter((a) => !a.startsWith('-'))[0];
    if (!url) {
      this.print('curl: try \'curl --help\' for more information');
      return false;
    }
    this.run(() => {});
    httpFetch(this.host, url.includes('://') ? url : `http://${url}`, (r) => {
      if (r.ok || r.status) {
        this.print((r.body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        this.print(`[HTTP ${r.status} ${r.statusText}, ${r.size} bayt, ${Math.round(r.ms)} ms]`);
      } else this.print(`curl: ${r.error}`);
      this.done();
    });
    return true;
  }
}

type Cmd = (sh: HostShell, args: string[]) => boolean;

const COMMON: Record<string, Cmd> = {
  ping: (sh, a) => sh.ping(a),
  telnet: (sh, a) => sh.remoteLogin('telnet', a),
  ssh: (sh, a) => sh.remoteLogin('ssh', a),
  hostname: (sh) => (sh.print(sh.host.label), false),
  nslookup: (sh, a) => sh.nslookup(a),
  curl: (sh, a) => sh.curl(a),
  netstat: (sh) => sh.netstat(),
};

const WIN: Record<string, Cmd> = {
  help: (sh) => {
    sh.print('Available Commands:\n?\narp\ncls\ncurl\ngetmac\nhelp\nhostname\nipconfig\nnetstat\nnslookup\nping\nroute\nssh\ntelnet\ntracert');
    return false;
  },
  '?': (sh) => WIN.help(sh, []),
  ipconfig: (sh, a) => sh.ipconfig(a),
  tracert: (sh, a) => sh.tracert(a),
  arp: (sh, a) => sh.arp(a),
  cls: (sh) => (sh.out.write('\x1b[2J'), false),
  getmac: (sh) => {
    sh.print('\nPhysical Address    Transport Name');
    sh.print('=================== ==========================================================');
    for (const n of sh.host.nics) sh.print(`${macWindows(n.port.mac)}   \\Device\\Tcpip_{${n.port.name}}`);
    return false;
  },
  route: (sh) => {
    const h = sh.host;
    sh.print('===========================================================================\nIPv4 Route Table\n===========================================================================\nActive Routes:\nNetwork Destination        Netmask          Gateway       Interface  Metric');
    for (const r of h.stack.routes()) sh.print(`${padRight(r.network, 27)}${padRight(r.mask, 17)}${padRight(r.nextHop ?? 'On-link', 14)}${padRight(r.iface?.ip ?? h.nics[0].iface.ip ?? '', 11)}${r.code === 'C' ? 281 : 25}`);
    sh.print('===========================================================================');
    return false;
  },
};

const LINUX: Record<string, Cmd> = {
  ip: (sh, a) => {
    const h = sh.host;
    if (a[0]?.startsWith('r')) {
      for (const r of h.stack.routes()) sh.print(r.prefix === 0 ? `default via ${r.nextHop} dev ${h.nics[0].port.name.toLowerCase()}` : `${r.network}/${r.prefix} dev ${r.iface?.name.toLowerCase()} proto kernel scope link src ${r.iface?.ip}`);
      return false;
    }
    let idx = 1;
    sh.print('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN\n    inet 127.0.0.1/8 scope host lo');
    for (const n of h.nics) {
      idx++;
      sh.print(`${idx}: ${n.port.name.toLowerCase()}: <BROADCAST,MULTICAST${n.port.operUp ? ',UP,LOWER_UP' : ''}> mtu 1500 state ${n.port.operUp ? 'UP' : 'DOWN'}`);
      sh.print(`    link/ether ${n.port.mac} brd ff:ff:ff:ff:ff:ff`);
      if (n.iface.ip) sh.print(`    inet ${n.iface.ip}/${n.iface.prefix} brd ${n.iface.network} scope global ${n.cfg.mode === 'dhcp' ? 'dynamic ' : ''}${n.port.name.toLowerCase()}`);
    }
    return false;
  },
  ifconfig: (sh) => {
    for (const n of sh.host.nics) {
      sh.print(`${n.port.name.toLowerCase()}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`);
      if (n.iface.ip) sh.print(`        inet ${n.iface.ip}  netmask ${n.iface.mask}`);
      sh.print(`        ether ${n.port.mac}  txqueuelen 1000  (Ethernet)`);
      sh.print(`        RX packets ${n.port.counters.rxFrames}  bytes ${n.port.counters.rxBytes}`);
      sh.print(`        TX packets ${n.port.counters.txFrames}  bytes ${n.port.counters.txBytes}`);
      sh.print('');
    }
    return false;
  },
  traceroute: (sh, a) => sh.tracert(a),
  arp: (sh, a) => sh.arp(a),
  dig: (sh, a) => sh.nslookup(a),
  ss: (sh) => sh.netstat(),
  clear: (sh) => (sh.out.write('\x1b[2J'), false),
  uptime: (sh) => {
    const h = sh.host;
    const cpu = h.http.current.cpu / 100;
    sh.print(` up ${formatUptime(h.now - h.bootedAt)},  1 user,  load average: ${(cpu * h.hardware.cpuCores).toFixed(2)}, ${(cpu * h.hardware.cpuCores * 0.8).toFixed(2)}, ${(cpu * h.hardware.cpuCores * 0.6).toFixed(2)}`);
    return false;
  },
  top: (sh) => {
    const h = sh.host;
    const s = h.http.current;
    sh.print(`top - up ${formatUptime(h.now - h.bootedAt)},  load average: ${((s.cpu / 100) * h.hardware.cpuCores).toFixed(2)}`);
    sh.print(`Tasks: ${120 + s.active} total,   ${Math.ceil((s.cpu / 100) * h.hardware.cpuCores)} running`);
    sh.print(`%Cpu(s): ${s.cpu.toFixed(1)} us,  ${(s.cpu * 0.1).toFixed(1)} sy,  ${(100 - s.cpu).toFixed(1)} id   (${h.hardware.cpuCores} yadro × ${h.hardware.cpuGhz} GHz)`);
    sh.print(`MiB Mem :  ${h.hardware.ramMb.toFixed(1)} total,  ${(h.hardware.ramMb - h.http.ramUsedMb()).toFixed(1)} free,  ${h.http.ramUsedMb().toFixed(1)} used`);
    sh.print('');
    sh.print(`  PID USER      %CPU  %MEM COMMAND`);
    sh.print(`  812 www-data  ${s.cpu.toFixed(1).padStart(5)}  ${(s.ram * 0.6).toFixed(1).padStart(4)} nginx: worker process   (${s.rps} req/s, navbat ${s.queue}, ${s.active} ulanish)`);
    sh.print(`  640 bind      ${(h.dns.queries ? 0.3 : 0).toFixed(1).padStart(5)}   0.4 named`);
    sh.print(`    1 root        0.0   0.1 systemd`);
    return false;
  },
  help: (sh) => (sh.print('ip a | ip r | ifconfig | ping | traceroute | arp -n | nslookup | dig | ss | curl | top | uptime | ssh | telnet'), false),
};

/** Kompyuterning RS-232 portidan konsol kabeli orqali router/switch CLI siga ulanish */
export function openConsole(host: Host): TerminalSession | string {
  const rs = host.ports.find((p) => p.media === 'console');
  if (!rs) return 'Bu qurilmada RS-232 port yo\'q';
  if (!rs.link) return 'Konsol kabeli ulanmagan (RS 232 portiga Console kabelini ulang)';
  const peer = rs.peer!;
  const d = peer.device as NetOsDevice;
  if (!d.powered) return 'Qurilma o\'chirilgan';
  if (!(d as any).stack || typeof (d as any).runningConfig !== 'function') return 'Ulangan qurilmada konsol CLI yo\'q';
  return new IosCli(d, 'con');
}

export { isValidIp };
