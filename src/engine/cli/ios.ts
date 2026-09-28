// Cisco IOS buyruqlar qatori (CLI): rejimlar, parollar, konfiguratsiya va diagnostika buyruqlari.
import type { NetOsDevice } from '../devices/netos';
import { type5, type7, decode7 } from './crypto';
import type { Router } from '../devices/router';
import { isRouter, isSwitch } from '../devices/kinds';
import type { Switch } from '../devices/switch';
import type { Port } from '../port';
import type { L3Interface } from '../l3';
import { CommandSet, tokenize, Args } from './parser';
import { OutputBus, TerminalSession } from './terminal';
import { pingOnce, traceroute, newIdent } from './apps';
import { showCommand, showHelp, showComplete, SHOW_HELP } from './show';
import { expandIfName, shortIfName } from '../port';
import { isStandardAclNumber, isExtendedAclNumber, parseAclEntry } from '../protocols/acl';
import { OspfProcess } from '../protocols/ospf';
import type { DhcpPool } from '../protocols/dhcp';
import { formatVlanList, isValidIp, isValidMask, parseVlanList, networkOf, wildcardToMask } from '../util';
import { openRemoteTerminal } from './remote';

export type IosMode =
  | 'user'
  | 'priv'
  | 'config'
  | 'if'
  | 'subif'
  | 'if-range'
  | 'vlan'
  | 'line'
  | 'router'
  | 'dhcp'
  | 'std-nacl'
  | 'ext-nacl'
  | 'telephony'
  | 'ephone'
  | 'ephone-dn';

const CONFIG_SUBMODES: IosMode[] = ['if', 'subif', 'if-range', 'vlan', 'line', 'router', 'dhcp', 'std-nacl', 'ext-nacl', 'telephony', 'ephone', 'ephone-dn'];
const ALL_CONFIG: IosMode[] = ['config', ...CONFIG_SUBMODES];
const IF_MODES: IosMode[] = ['if', 'subif', 'if-range'];

const PROMPT_SUFFIX: Record<IosMode, string> = {
  user: '>',
  priv: '#',
  config: '(config)#',
  if: '(config-if)#',
  subif: '(config-subif)#',
  'if-range': '(config-if-range)#',
  vlan: '(config-vlan)#',
  line: '(config-line)#',
  router: '(config-router)#',
  dhcp: '(dhcp-config)#',
  'std-nacl': '(config-std-nacl)#',
  'ext-nacl': '(config-ext-nacl)#',
  telephony: '(config-telephony)#',
  ephone: '(config-ephone)#',
  'ephone-dn': '(config-ephone-dn)#',
};

const KW_HELP: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  show: 'Show running system information',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  telnet: 'Open a telnet connection',
  ssh: 'Open a secure shell client connection',
  exit: 'Exit from the EXEC',
  end: 'Exit from configure mode',
  copy: 'Copy from one file to another',
  write: 'Write running configuration to memory, network, or terminal',
  reload: 'Halt and perform a cold restart',
  erase: 'Erase a filesystem',
  clear: 'Reset functions',
  hostname: "Set system's network name",
  interface: 'Select an interface to configure',
  ip: 'Global IP configuration subcommands',
  no: 'Negate a command or set its defaults',
  vlan: 'Vlan commands',
  shutdown: 'Shutdown the selected interface',
  switchport: 'Set switching mode characteristics',
  description: 'Interface specific description',
  address: 'Set the IP address of an interface',
  route: 'Establish static routes',
  'spanning-tree': 'Spanning Tree Subsystem',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  mode: 'Set trunking mode of the interface',
  encapsulation: 'Set encapsulation type for an interface',
  dot1q: 'IEEE 802.1Q Virtual LAN',
  line: 'Configure a terminal line',
  password: 'Set a password',
  login: 'Enable password checking',
  secret: 'Assign the privileged level secret',
  service: 'Modify use of network based services',
  banner: 'Define a login banner',
  router: 'Enable a routing process',
  network: 'Enable routing on an IP network',
  dhcp: 'Configure DHCP server and relay parameters',
  pool: 'Configure DHCP address pools',
  'default-router': 'Default routers',
  'dns-server': 'DNS servers',
  'access-list': 'Add an access list entry',
  permit: 'Specify packets to forward',
  deny: 'Specify packets to reject',
  nat: 'NAT configuration commands',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  do: 'To run exec commands in config mode',
  'telephony-service': 'Configure Cisco IP Telephony (CIPT) system',
  'ephone-dn': 'Configure ephone directory number',
  ephone: 'Configure Cisco Ethernet Phone',
  cdp: 'Global CDP configuration subcommands',
  username: 'Establish User Name Authentication',
  crypto: 'Encryption module',
  speed: 'Configure speed operation',
  duplex: 'Configure duplex operation',
  helper: 'Specify a destination address for UDP broadcasts',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  voice: 'Set voice characteristics of the interface',
  native: 'Set native VLAN when interface is in trunking mode',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  'port-security': 'Security related command',
  portfast: 'Portfast options for the interface',
  bpduguard: "Don't accept BPDUs on this interface",
  name: 'Ascii name of the VLAN',
  routing: 'Enable IP routing',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  'domain-name': 'Define the default domain name',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  ospf: 'Open Shortest Path First (OSPF)',
  area: 'Set the OSPF area ID',
  mls: 'mls global commands',
  qos: 'qos',
  power: 'Power configuration',
  inline: 'Inline power configuration',
};

type Target = { name: string; port?: Port; l3?: L3Interface };

export class IosCli implements TerminalSession {
  dev: NetOsDevice;
  lineKind: 'con' | 'vty';
  mode: IosMode = 'user';
  targets: Target[] = [];
  vlanCtx: number[] = [];
  lineCtx: 'con' | 'vty' = 'con';
  poolCtx: DhcpPool | null = null;
  aclCtx: string | null = null;
  ephoneCtx = 0;
  dnCtx = 0;
  out = new OutputBus();
  history: string[] = [];
  silent = false;
  errors: string[] = [];
  private pending: { secret: boolean; handler: (line: string) => void } | null = null;
  private busy: { cancel: () => void } | null = null;
  private closeFns: (() => void)[] = [];
  private closed = false;
  private consoleUnsub: (() => void) | null = null;
  private authTries = 0;
  remoteFrom = 'console';
  /** Masofaviy (telnet/ssh) sessiya ichida bo'lsak */
  private remote: TerminalSession | null = null;
  private remoteUnsub: (() => void) | null = null;

  static cmds = buildCommands();

  constructor(dev: NetOsDevice, line: 'con' | 'vty' = 'con', opts: { silent?: boolean; skipLogin?: boolean; from?: string } = {}) {
    this.dev = dev;
    this.lineKind = line;
    this.silent = !!opts.silent;
    this.remoteFrom = opts.from ?? (line === 'con' ? 'console' : 'unknown');
    if (!this.silent) {
      this.consoleUnsub = dev.onConsole((t) => {
        if (this.lineKind === 'con' || this.dev.ios.vty.loggingSync) this.out.line(t);
      });
      const ref = { line, user: '', from: this.remoteFrom, since: dev.now, close: () => this.close() };
      dev.sessions.add(ref);
      this.closeFns.push(() => dev.sessions.delete(ref));
    }
    if (!opts.skipLogin && !this.silent) this.startLogin();
  }

  // ------------------------------------------------------------------ TerminalSession
  onOutput(fn: (t: string) => void) {
    const buf = this.out.buffer.splice(0);
    const un = this.out.on(fn);
    for (const b of buf) fn(b);
    return un;
  }

  onClose(fn: () => void) {
    this.closeFns.push(fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.consoleUnsub?.();
    this.busy?.cancel();
    this.remote?.close?.();
    for (const f of this.closeFns) f();
  }

  isSecret() {
    if (this.remote) return this.remote.isSecret?.() ?? false;
    return !!this.pending?.secret;
  }

  isBusy() {
    if (this.remote) return this.remote.isBusy?.() ?? false;
    return !!this.busy;
  }

  prompt(): string {
    if (this.remote) return this.remote.prompt();
    if (this.pending) return '';
    return this.dev.hostname + PROMPT_SUFFIX[this.mode];
  }

  print(t = '') {
    if (this.silent) return;
    this.out.line(t);
  }

  err(t: string) {
    this.errors.push(t);
    this.print(t);
  }

  interrupt() {
    if (this.remote) {
      this.remote.interrupt?.();
      return;
    }
    if (this.busy) {
      this.busy.cancel();
      this.busy = null;
      this.print('');
      this.print(this.prompt());
    }
  }

  // ------------------------------------------------------------------ login
  private startLogin() {
    const ios = this.dev.ios;
    const line = this.lineKind === 'con' ? ios.con : ios.vty;
    if (ios.bannerMotd) this.print(ios.bannerMotd);
    if (this.lineKind === 'vty') {
      if (line.login === 'line' && !line.password) {
        this.print('');
        this.print('Password required, but none set');
        this.print('');
        this.dev.setTimer(10, () => this.close());
        this.closed = false;
        return;
      }
    }
    if (line.login === 'line' && line.password) {
      this.print('');
      this.print('User Access Verification');
      this.print('');
      this.askPassword(line.password);
    } else if (line.login === 'local') {
      this.print('');
      this.print('User Access Verification');
      this.print('');
      this.askUsername();
    } else {
      this.afterLogin();
    }
  }

  private askPassword(expected: string) {
    this.writePrompt('Password: ');
    this.pending = {
      secret: true,
      handler: (l) => {
        this.pending = null;
        if (l === expected) {
          this.authTries = 0;
          this.afterLogin();
        } else if (++this.authTries >= 3) {
          this.print('% Bad passwords');
          this.print('');
          if (this.lineKind === 'vty') this.close();
          else {
            this.authTries = 0;
            this.startLogin();
          }
        } else this.askPassword(expected);
      },
    };
  }

  private askUsername() {
    this.writePrompt('Username: ');
    this.pending = {
      secret: false,
      handler: (u) => {
        this.writePrompt('Password: ');
        this.pending = {
          secret: true,
          handler: (pw) => {
            this.pending = null;
            const user = this.dev.ios.users.find((x) => x.name === u);
            if (user && ((user.secret && user.secret === type5(pw)) || (user.password !== undefined && user.password === pw))) {
              this.authTries = 0;
              for (const s of this.dev.sessions) if (s.line === this.lineKind && s.from === this.remoteFrom) s.user = u;
              if (user.privilege >= 15) this.mode = 'priv';
              this.afterLogin();
            } else {
              this.print('% Login invalid');
              this.print('');
              if (++this.authTries >= 3 && this.lineKind === 'vty') this.close();
              else this.askUsername();
            }
          },
        };
      },
    };
  }

  private afterLogin() {
    this.print('');
    this.writePrompt(this.prompt());
  }

  private writePrompt(p: string) {
    if (this.silent) return;
    this.out.write(p);
  }

  // ------------------------------------------------------------------ kiritish
  input(raw: string) {
    if (this.closed) return;
    if (this.remote) {
      this.remote.input(raw);
      return;
    }
    if (this.pending) {
      const p = this.pending;
      if (!p.secret) this.out.write(raw + '\n');
      else this.out.write('\n');
      p.handler(raw);
      return;
    }
    if (this.busy) return;
    if (!this.silent) this.out.write(raw + '\n');
    const line = raw.replace(/\s+$/, '');
    if (line.trim() && !this.silent) {
      this.history.push(line);
      if (this.history.length > 50) this.history.shift();
    }
    // "?" yordam
    if (line.endsWith('?')) {
      this.help(line.slice(0, -1));
      this.writePrompt(this.prompt() + (line.slice(0, -1) ? '' : ''));
      return;
    }
    this.execute(line);
    if (!this.busy && !this.pending && !this.closed && !this.remote) this.writePrompt(this.prompt());
  }

  help(line: string) {
    const w = tokenize(line);
    let lines: string[];
    const isShow = (x: string | undefined) => !!x && x.length >= 2 && 'show'.startsWith(x.toLowerCase());
    if ((this.mode === 'user' || this.mode === 'priv') && isShow(w[0]) && (w.length > 1 || /\s$/.test(line))) lines = showHelp(this, line.replace(/^\s*\S+\s*/, ''));
    else if (CONFIG_SUBMODES.concat('config').includes(this.mode) && w[0]?.toLowerCase() === 'do' && isShow(w[1]) && (w.length > 2 || /\s$/.test(line))) lines = showHelp(this, line.replace(/^\s*\S+\s+\S+\s*/, ''));
    else lines = IosCli.cmds.help(this.helpMode(), line, (x) => KW_HELP[x] ?? SHOW_HELP[x] ?? '');
    if (!lines.length) this.print('% Unrecognized command');
    else for (const l of lines) this.print(l);
  }

  private helpMode(): string {
    return this.mode;
  }

  complete(line: string): string | null {
    if (this.remote) return this.remote.complete?.(line) ?? null;
    const w = tokenize(line);
    if ((this.mode === 'user' || this.mode === 'priv') && w.length > 1 && w[0].length >= 2 && 'show'.startsWith(w[0].toLowerCase())) {
      const head = line.match(/^\s*\S+\s+/)![0];
      const r = showComplete(line.slice(head.length));
      return r ? head + r : null;
    }
    const c = IosCli.cmds.complete(this.mode, line);
    if (c) return c;
    if (CONFIG_SUBMODES.includes(this.mode)) return IosCli.cmds.complete('config', line);
    return null;
  }

  execute(line: string) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) return;
    let words = tokenize(trimmed);
    // Ctrl+Z
    if (trimmed === '\x1a') words = ['end'];
    let mode = this.mode;
    let res = IosCli.cmds.parse(mode, words);
    // Kichik rejimda global buyruq — rejimdan chiqib bajariladi
    if (!res.ok && CONFIG_SUBMODES.includes(mode) && (res.error === 'invalid' || res.error === 'unknown')) {
      const g = IosCli.cmds.parse('config', words);
      if (g.ok) {
        this.mode = 'config';
        mode = 'config';
        res = g;
      }
    }
    if (!res.ok) {
      switch (res.error) {
        case 'invalid': {
          const col = this.caretCol(trimmed, res.pos);
          this.err(' '.repeat(this.prompt().length + col) + '^');
          this.err("% Invalid input detected at '^' marker.");
          this.print('');
          break;
        }
        case 'incomplete':
          this.err('% Incomplete command.');
          this.print('');
          break;
        case 'ambiguous':
          this.err(`% Ambiguous command:  "${res.word}"`);
          break;
        case 'unknown':
          if (this.mode === 'user' || this.mode === 'priv') {
            this.unknownExecWord(words[0]);
          } else {
            const col = this.caretCol(trimmed, 0);
            this.err(' '.repeat(this.prompt().length + col) + '^');
            this.err("% Invalid input detected at '^' marker.");
            this.print('');
          }
          break;
      }
      return;
    }
    try {
      const r = res.cmd.run(this, res.args);
      if (r && typeof (r as any).then === 'function') (r as Promise<void>).catch((e) => this.err(String(e)));
    } catch (e: any) {
      this.err(`% ${e?.message ?? e}`);
    }
    if (ALL_CONFIG.includes(mode) && res.cmd.pattern !== 'end' && res.cmd.pattern !== 'exit') this.dev.lastConfigChange = this.dev.now;
  }

  private caretCol(line: string, pos: number) {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(line))) {
      if (i === pos) return m.index;
      i++;
    }
    return line.length;
  }

  private unknownExecWord(w: string) {
    if (this.dev.ios.domainLookup) {
      this.print(`Translating "${w}"...domain server (255.255.255.255)`);
      this.busy = { cancel: () => {} };
      this.dev.setTimer(3000, () => {
        this.busy = null;
        this.print('% Unknown command or computer name, or unable to find computer address');
        this.writePrompt(this.prompt());
      });
    } else {
      this.print('Translating "' + w + '"');
      this.print('% Unknown command or computer name, or unable to find computer address');
    }
  }

  // ------------------------------------------------------------------ yordamchilar
  get isRouter() {
    return isRouter(this.dev);
  }

  get sw(): Switch | null {
    return isSwitch(this.dev) ? this.dev : null;
  }

  get router(): Router | null {
    return isRouter(this.dev) ? this.dev : null;
  }

  runAsync(cancel: () => void) {
    this.busy = { cancel };
  }

  finishAsync() {
    if (!this.busy) return;
    this.busy = null;
    if (!this.closed && !this.remote) this.writePrompt(this.prompt());
  }

  ask(question: string, handler: (answer: string) => void, secret = false) {
    this.writePrompt(question);
    this.pending = {
      secret,
      handler: (l) => {
        this.pending = null;
        handler(l);
        if (!this.pending && !this.busy && !this.closed && !this.remote) this.writePrompt(this.prompt());
      },
    };
  }

  /** Interfeys nomini hal qilish va kontekst yaratish */
  resolveInterface(name: string, create: boolean): Target | string {
    const dev = this.dev;
    const full = expandIfName(name) ?? name;
    const m = full.match(/^(.*?)(\d+(?:\/\d+)*)(?:\.(\d+))?$/);
    if (!m) return '% Invalid interface';
    if (full.startsWith('Loopback')) {
      const n = Number(full.replace('Loopback', ''));
      let i = dev.stack.iface(full);
      if (!i && create) {
        i = dev.makeLoopback(n);
        dev.stack.addInterface(i);
        dev.sortInterfaces();
        dev.syslog('LINK', 3, 'UPDOWN', `Interface ${full}, changed state to up`);
      }
      return i ? { name: full, l3: i } : '% Invalid interface';
    }
    if (full.startsWith('Vlan')) {
      const sw = this.sw;
      if (!sw) return '% Invalid input detected';
      const v = Number(full.replace('Vlan', ''));
      if (!(v >= 1 && v <= 4094)) return '% Invalid VLAN';
      let i = sw.fabric.svis.get(v);
      if (!i && create) {
        i = sw.ensureSvi(v);
        dev.syslog('LINK', 3, 'UPDOWN', `Interface ${full}, changed state to down`);
      }
      return i ? { name: full, l3: i } : '% Invalid interface';
    }
    if (m[3] !== undefined) {
      // subinterfeys
      const parentName = full.split('.')[0];
      const port = dev.ports.find((p) => p.name === parentName);
      if (!port || port.switchport) return '% Invalid interface';
      let i = dev.stack.iface(full);
      if (!i && create) {
        i = dev.makeSubIface(port, full);
        dev.stack.addInterface(i);
        dev.sortInterfaces();
      }
      return i ? { name: full, port, l3: i } : '% Invalid interface';
    }
    const port = dev.ports.find((p) => p.name === full && p.media !== 'console');
    if (!port) return '% Invalid interface';
    const l3 = dev.stack.interfaces.find((i) => i.kind === 'physical' && i.port === port);
    return { name: full, port, l3 };
  }

  forTargets(fn: (t: Target) => void) {
    for (const t of this.targets) fn(t);
  }

  refresh() {
    this.dev.stack.invalidate();
    this.dev.net.refresh();
  }

  static replay(dev: NetOsDevice, text: string): string[] {
    const cli = new IosCli(dev, 'con', { silent: true, skipLogin: true });
    cli.mode = 'priv';
    cli.execute('configure terminal');
    const lines = text.split(/\r?\n/);
    const errors: string[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      const t = l.trim();
      if (!t || t.startsWith('!') || t === 'end' || t.startsWith('Building configuration') || t.startsWith('Current configuration') || t.startsWith('version ')) continue;
      // banner motd ^C ... ^C (ko'p qatorli)
      const bm = t.match(/^banner\s+motd\s+(\S)/);
      if (bm) {
        const delim = bm[1] === '^' && t.includes('^C') ? '^C' : bm[1];
        let body = t.slice(t.indexOf(delim) + delim.length);
        while (!body.includes(delim) && idx + 1 < lines.length) body += '\n' + lines[++idx];
        dev.ios.bannerMotd = body.slice(0, body.indexOf(delim));
        continue;
      }
      cli.errors = [];
      cli.execute(t);
      if (cli.errors.length) errors.push(`${t}: ${cli.errors.join(' ')}`);
    }
    cli.close();
    dev.net?.refresh();
    return errors;
  }

  /** telnet / ssh orqali boshqa qurilmaga ulanish */
  connectRemote(host: string, proto: 'telnet' | 'ssh', user?: string) {
    this.print(proto === 'telnet' ? `Trying ${host} ...` : '');
    this.runAsync(() => {});
    openRemoteTerminal(this.dev, this.dev.stack, this.dev.resolver, host, proto, user, {
      onOpen: (sess) => {
        this.busy = null;
        if (proto === 'telnet') this.print(`Trying ${host} ... Open`);
        this.remote = sess;
        this.remoteUnsub = sess.onOutput((t) => this.out.write(t));
        sess.onClose?.(() => {
          this.remoteUnsub?.();
          this.remote = null;
          this.print('');
          this.print(`[Connection to ${host} closed by foreign host]`);
          this.writePrompt(this.prompt());
        });
      },
      onError: (msg) => {
        this.print(msg);
        this.print('');
        this.finishAsync();
      },
    });
  }
}

// =======================================================================================
// Buyruqlar
// =======================================================================================

function buildCommands(): CommandSet<IosCli> {
  const c = new CommandSet<IosCli>();
  const EXEC: IosMode[] = ['user', 'priv'];

  // ----------------------------------------------------------------- EXEC
  c.add(EXEC, 'enable', (cli) => {
    if (cli.mode === 'priv') return;
    const ios = cli.dev.ios;
    const check = (l: string) => (ios.enableSecret ? type5(l) === ios.enableSecret : l === ios.enablePassword);
    if (!ios.enableSecret && !ios.enablePassword) {
      if (cli.lineKind === 'vty') {
        cli.print('% No password set');
        return;
      }
      cli.mode = 'priv';
      return;
    }
    let tries = 0;
    const askPw = () =>
      cli.ask(
        'Password: ',
        (l) => {
          if (check(l)) cli.mode = 'priv';
          else if (++tries >= 3) cli.print('% Bad secrets\n');
          else askPw();
        },
        true,
      );
    askPw();
  });
  c.add('priv', 'disable', (cli) => {
    cli.mode = 'user';
  });
  c.add(EXEC, 'exit|logout|quit', (cli) => {
    if (cli.lineKind === 'vty') {
      cli.close();
      return;
    }
    cli.mode = 'user';
    cli.print('');
    cli.print(`${cli.dev.hostname} con0 is now available`);
    cli.print('');
    cli.print('Press RETURN to get started.');
    cli.print('');
  });
  c.add('priv', 'configure [terminal]', (cli) => {
    cli.print('Enter configuration commands, one per line.  End with CNTL/Z.');
    cli.mode = 'config';
  });
  c.add(EXEC, 'terminal length <n:num:0-512>', () => {});
  c.add(EXEC, 'terminal monitor', () => {});
  c.add('priv', 'clock set <time:word> <day:num:1-31> <month:word> <year:num:1993-2035>', (cli) => {
    cli.print('');
  });
  c.add('priv', 'copy running-config startup-config', (cli) => {
    cli.ask('Destination filename [startup-config]? ', () => {
      cli.dev.startupConfig = cli.dev.runningConfig();
      cli.print('Building configuration...');
      cli.print('[OK]');
    });
  });
  c.add('priv', 'copy startup-config running-config', (cli) => {
    cli.ask('Destination filename [running-config]? ', () => {
      if (cli.dev.startupConfig) {
        cli.dev.applyConfig(cli.dev.startupConfig);
        cli.print(`${cli.dev.startupConfig.length} bytes copied in 0.416 secs`);
      } else cli.print('%% Non-volatile configuration memory invalid or not present');
    });
  });
  c.add('priv', 'write [memory]', (cli) => {
    cli.dev.startupConfig = cli.dev.runningConfig();
    cli.print('Building configuration...');
    cli.print('[OK]');
  });
  c.add('priv', 'write terminal', (cli) => {
    for (const l of cli.dev.runningConfig().split('\n')) cli.print(l);
  });
  c.add('priv', 'write erase', (cli) => eraseStartup(cli));
  c.add('priv', 'erase startup-config|nvram:', (cli) => eraseStartup(cli));
  c.add('priv', 'reload', (cli) => {
    const changed = cli.dev.startupConfig !== cli.dev.runningConfig();
    const doReload = () =>
      cli.ask('Proceed with reload? [confirm]', (a) => {
        if (a.toLowerCase().startsWith('n')) return;
        const dev = cli.dev;
        cli.print('');
        cli.print('%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
        cli.close();
        dev.powerSwitch = false;
        dev.net.refresh();
        dev.net.sim.schedule(3000, () => {
          dev.powerSwitch = true;
          dev.net.refresh();
          dev.console(bootBanner(dev));
        });
      });
    if (changed) {
      cli.ask('System configuration has been modified. Save? [yes/no]: ', (a) => {
        if (a.toLowerCase().startsWith('y')) {
          cli.dev.startupConfig = cli.dev.runningConfig();
          cli.print('Building configuration...');
          cli.print('[OK]');
        }
        doReload();
      });
    } else doReload();
  });
  c.add('priv', 'clear mac address-table [dynamic]', (cli) => cli.sw?.fabric.flushAll());
  c.add('priv', 'clear mac-address-table [dynamic]', (cli) => cli.sw?.fabric.flushAll());
  c.add('priv', 'clear arp-cache|arp', (cli) => {
    for (const [ip, e] of [...cli.dev.stack.arp]) if (e.type === 'dynamic') cli.dev.stack.arp.delete(ip);
  });
  c.add('priv', 'clear ip nat translation *', (cli) => cli.dev.stack.nat.clearDynamic());
  c.add('priv', 'clear ip ospf process', (cli) => {
    cli.ask('Reset ALL OSPF processes? [no]: ', (a) => {
      if (a.startsWith('y')) {
        cli.dev.ospf?.reset();
        cli.dev.ospf?.start();
      }
    });
  });
  c.add('priv', 'clear counters', (cli) => {
    cli.ask('Clear "show interface" counters on all interfaces [confirm]', () => {
      for (const p of cli.dev.ports) p.resetCounters();
    });
  });
  c.add('priv', 'clear port-security all|sticky|dynamic', (cli) => {
    for (const p of cli.dev.ports) if (p.switchport) p.switchport.portSecurity.secureMacs = [];
  });
  c.add('priv', 'debug <what:line>', (cli, a) => cli.print(`${a.what} debugging is on`));
  c.add('priv', 'undebug all', (cli) => cli.print('All possible debugging has been turned off'));
  c.add(EXEC, 'show <what:line>', (cli, a) => {
    showCommand(cli, a.what);
  });

  c.add(EXEC, 'ping <host:word> [repeat] [<count:num:1-1000>] [size] [<size:num:36-18024>] [source] [<src:word>]', (cli, a) => ping(cli, a));
  c.add(EXEC, 'traceroute <host:word>', (cli, a) => trace(cli, a.host));
  c.add(EXEC, 'telnet <host:word>', (cli, a) => cli.connectRemote(a.host, 'telnet'));
  c.add(EXEC, 'ssh -l <user:word> <host:word>', (cli, a) => cli.connectRemote(a.host, 'ssh', a.user));

  // ----------------------------------------------------------------- umumiy (config)
  c.add(ALL_CONFIG, 'end', (cli) => {
    cli.mode = 'priv';
    cli.dev.syslog('SYS', 5, 'CONFIG_I', `Configured from console by ${cli.lineKind === 'con' ? 'console' : 'vty0'}`);
  });
  c.add(ALL_CONFIG, 'exit', (cli) => {
    if (cli.mode === 'config') {
      cli.mode = 'priv';
      cli.dev.syslog('SYS', 5, 'CONFIG_I', 'Configured from console by console');
    } else if (cli.mode === 'ephone-dn' || cli.mode === 'ephone' || cli.mode === 'telephony') cli.mode = 'config';
    else cli.mode = 'config';
  });
  c.add(ALL_CONFIG, 'do <cmd:line>', (cli, a) => {
    const m = cli.mode;
    cli.mode = 'priv';
    cli.execute(a.cmd);
    cli.mode = m;
  });

  c.add('config', 'hostname <name:word>', (cli, a) => {
    cli.dev.hostname = a.name;
    cli.dev.net.bump();
  });
  c.add('config', 'enable secret [0|5] <pw:word>', (cli, a) => {
    cli.dev.ios.enableSecret = a.no ? null : a['0|5'] === '5' ? a.pw : type5(a.pw);
  }, { no: 'allow' });
  c.add('config', 'enable secret', (cli) => (cli.dev.ios.enableSecret = null), { no: 'only' });
  c.add('config', 'enable password [0|7] <pw:word>', (cli, a) => {
    cli.dev.ios.enablePassword = a['0|7'] === '7' ? decode7(a.pw) : a.pw;
  });
  c.add('config', 'enable password', (cli) => (cli.dev.ios.enablePassword = null), { no: 'only' });
  c.add('config', 'service password-encryption', (cli, a) => (cli.dev.ios.servicePasswordEncryption = !a.no), { no: 'allow' });
  c.add('config', 'banner motd <text:line>', (cli, a) => {
    const t: string = a.text;
    const d = t[0];
    const rest = t.slice(1);
    const end = rest.indexOf(d);
    if (end >= 0) cli.dev.ios.bannerMotd = rest.slice(0, end);
    else {
      cli.print(`Enter TEXT message.  End with the character '${d}'.`);
      let body = rest;
      const more = () =>
        cli.ask('', (l) => {
          const e = l.indexOf(d);
          if (e >= 0) {
            body += (body ? '\n' : '') + l.slice(0, e);
            cli.dev.ios.bannerMotd = body;
          } else {
            body += (body ? '\n' : '') + l;
            more();
          }
        });
      more();
    }
  });
  c.add('config', 'banner motd', (cli) => (cli.dev.ios.bannerMotd = null), { no: 'only' });
  c.add('config', 'ip domain-name <name:word>', (cli, a) => (cli.dev.ios.domainName = a.no ? '' : a.name), { no: 'allow' });
  c.add('config', 'ip domain name <name:word>', (cli, a) => (cli.dev.ios.domainName = a.no ? '' : a.name), { no: 'allow' });
  c.add('config', 'ip name-server <ip:ip>', (cli, a) => {
    const ios = cli.dev.ios;
    if (a.no) ios.nameServers = ios.nameServers.filter((x) => x !== a.ip);
    else if (!ios.nameServers.includes(a.ip)) ios.nameServers.push(a.ip);
    cli.dev.stack.dnsServers = ios.nameServers;
  }, { no: 'allow' });
  c.add('config', 'ip domain-lookup', (cli, a) => (cli.dev.ios.domainLookup = !a.no), { no: 'allow' });
  c.add('config', 'ip domain lookup', (cli, a) => (cli.dev.ios.domainLookup = !a.no), { no: 'allow' });
  c.add('config', 'ip host <name:word> <ip:ip>', (cli, a) => {
    if (a.no) {
      cli.dev.ios.ipHosts.delete(a.name);
      cli.dev.resolver.hosts.delete(a.name.toLowerCase());
    } else {
      cli.dev.ios.ipHosts.set(a.name, a.ip);
      cli.dev.resolver.hosts.set(a.name.toLowerCase(), a.ip);
    }
  }, { no: 'allow' });
  c.add('config', 'username <name:word> [privilege] [<priv:num:0-15>] {kind:secret|password} [0|5|7] <pw:word>', (cli, a) => {
    const ios = cli.dev.ios;
    const t = a['0|5|7'];
    ios.users = ios.users.filter((u) => u.name !== a.name);
    ios.users.push({ name: a.name, privilege: a.priv ?? 1, ...(a.kind === 'secret' ? { secret: t === '5' ? a.pw : type5(a.pw) } : { password: t === '7' ? decode7(a.pw) : a.pw }) });
  });
  c.add('config', 'username <name:word>', (cli, a) => {
    cli.dev.ios.users = cli.dev.ios.users.filter((u) => u.name !== a.name);
  }, { no: 'only' });
  c.add('config', 'crypto key generate rsa [general-keys] [modulus] [<bits:num:360-4096>]', (cli, a) => {
    const dev = cli.dev;
    if (dev.hostname === 'Router' || dev.hostname === 'Switch') {
      cli.print('% Please define a hostname other than Router.');
      return;
    }
    if (!dev.ios.domainName) {
      cli.print('% Please define a domain-name first.');
      return;
    }
    const gen = (bits: number) => {
      dev.ios.rsaBits = bits;
      cli.print(`% Generating ${bits} bit RSA keys, keys will be non-exportable...[OK]`);
      dev.syslog('SSH', 5, 'ENABLED', `SSH ${bits >= 768 ? '1.99' : '1.5'} has been enabled`);
      if (bits >= 768) dev.ios.sshVersion = dev.ios.sshVersion;
    };
    cli.print(`The name for the keys will be: ${dev.hostname}.${dev.ios.domainName}`);
    if (a.bits) gen(a.bits);
    else {
      cli.print('Choose the size of the key modulus in the range of 360 to 4096 for your');
      cli.print('  General Purpose Keys. Choosing a key modulus greater than 512 may take');
      cli.print('  a few minutes.');
      cli.print('');
      cli.ask('How many bits in the modulus [512]: ', (l) => gen(Number(l) || 512));
    }
  });
  c.add('config', 'crypto key zeroize rsa', (cli) => (cli.dev.ios.rsaBits = null));
  c.add('config', 'ip ssh version <v:num:1-2>', (cli, a) => {
    if (a.v === 2 && (cli.dev.ios.rsaBits ?? 0) < 768) {
      cli.print('Please create RSA keys (of atleast 768 bits size) to enable SSH v2.');
      return;
    }
    cli.dev.ios.sshVersion = a.v;
  });
  c.add('config', 'ip http server', (cli, a) => (cli.dev.ios.httpServer = !a.no), { no: 'allow' });
  c.add('config', 'logging <ip:ip>', (cli, a) => addLogHost(cli, a.ip, a.no), { no: 'allow' });
  c.add('config', 'logging host <ip:ip>', (cli, a) => addLogHost(cli, a.ip, a.no), { no: 'allow' });
  c.add('config', 'ntp server <ip:ip>', (cli, a) => (cli.dev.ios.ntpServer = a.no ? null : a.ip), { no: 'allow' });
  c.add('config', 'clock timezone <tz:word> <off:word>', () => {});
  c.add('config', 'cdp run', (cli, a) => {
    cli.dev.ios.cdpRun = !a.no;
    if (a.no) cli.dev.cdp.halt();
    else cli.dev.cdp.start();
  }, { no: 'allow' });
  c.add('config', 'lldp run', () => {}, { no: 'allow' });
  c.add('config', 'mls qos', (cli, a) => (cli.dev.qosEnabled = !a.no), { no: 'allow' });
  c.add('config', 'vtp mode {m:server|client|transparent}', (cli, a) => {
    if (!cli.sw) return cli.err('% Invalid input detected');
    cli.sw.fabric.vtpMode = a.m;
    cli.print(`Setting device to VTP ${a.m.toUpperCase()} mode.`);
  });
  c.add('config', 'vtp domain <d:word>', (cli, a) => {
    if (!cli.sw) return;
    cli.sw.fabric.vtpDomain = a.d;
    cli.print(`Changing VTP domain name from NULL to ${a.d}`);
  });
  c.add('config', 'mac address-table aging-time <s:num:0-1000000>', (cli, a) => {
    if (cli.sw) cli.sw.fabric.agingMs = a.s * 1000;
  });

  // ----------------------------------------------------------------- interface
  c.add(ALL_CONFIG, 'interface <if:iface>', (cli, a) => {
    const t = cli.resolveInterface(a.if, true);
    if (typeof t === 'string') {
      cli.err(t);
      return;
    }
    cli.targets = [t];
    cli.mode = t.l3?.kind === 'subif' ? 'subif' : 'if';
  });
  c.add(ALL_CONFIG, 'interface range <spec:line>', (cli, a) => {
    const names = expandRange(a.spec);
    if (!names) return cli.err('% Invalid input detected');
    const targets: Target[] = [];
    for (const n of names) {
      const t = cli.resolveInterface(n, false);
      if (typeof t === 'string') return cli.err(`% Command rejected: ${n} is not a valid interface`);
      targets.push(t);
    }
    cli.targets = targets;
    cli.mode = 'if-range';
  });
  c.add('config', 'interface <if:iface>', (cli, a) => {
    const t = cli.resolveInterface(a.if, false);
    if (typeof t === 'string' || !t.l3) return cli.err('% Invalid interface');
    if (t.l3.kind === 'subif' || t.l3.kind === 'loopback' || t.l3.kind === 'svi') {
      if (t.l3.kind === 'svi') cli.sw?.removeSvi(t.l3.sviVlan!);
      else cli.dev.stack.removeInterface(t.l3);
      cli.refresh();
    }
  }, { no: 'only' });

  c.add(IF_MODES, 'description <text:line>', (cli, a) =>
    cli.forTargets((t) => {
      if (t.port && t.l3?.kind !== 'subif') t.port.description = a.text;
      if (t.l3) t.l3.description = a.text;
    }),
  );
  c.add(IF_MODES, 'description', (cli) =>
    cli.forTargets((t) => {
      if (t.port) t.port.description = '';
      if (t.l3) t.l3.description = '';
    }), { no: 'only' });

  c.add(IF_MODES, 'shutdown', (cli, a) => {
    cli.forTargets((t) => {
      const up = !!a.no;
      if (t.port && t.l3?.kind !== 'subif') {
        const was = t.port.adminUp;
        t.port.adminUp = up;
        if (up) t.port.errDisabled = null;
        if (!up && was) {
          cli.dev.syslog('LINK', 5, 'CHANGED', `Interface ${t.port.name}, changed state to administratively down`);
        }
        if (up && !was && !t.port.link) {
          // kabel ulanmagan — "down"
          cli.dev.syslog('LINK', 3, 'UPDOWN', `Interface ${t.port.name}, changed state to down`);
        }
      }
      if (t.l3) {
        const was = t.l3.adminUp;
        t.l3.adminUp = up;
        if (t.l3.kind === 'svi' || t.l3.kind === 'subif' || t.l3.kind === 'loopback') {
          if (was !== up) {
            if (!up) cli.dev.syslog('LINK', 5, 'CHANGED', `Interface ${t.l3.name}, changed state to administratively down`);
            else if (t.l3.kind !== 'svi') cli.dev.syslog('LINK', 3, 'UPDOWN', `Interface ${t.l3.name}, changed state to up`);
          }
        }
        if (up) cli.dev.setTimer(20, () => cli.dev.stack.gratuitousArp(t.l3!));
      }
    });
    cli.refresh();
    cli.dev.ospf?.interfaceChange();
  }, { no: 'allow' });

  c.add(IF_MODES, 'ip address <ip:ip> <mask:mask> [secondary]', (cli, a) => {
    if (!isValidMask(a.mask)) return cli.err('% Bad mask 0x' + a.mask.split('.').map((x: string) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase() + ` for address ${a.ip}`);
    for (const t of cli.targets) {
      if (!t.l3) return cli.err("% Invalid input detected at '^' marker.");
      if (networkOf(a.ip, a.mask) === a.ip && a.mask !== '255.255.255.255') return cli.err('% Bad mask /' + a.mask + ' for address ' + a.ip);
      // bir xil tarmoq boshqa interfeysda bo'lmasligi kerak
      const overlap = cli.dev.stack.interfaces.find((i) => i !== t.l3 && i.hasIp && networkOf(i.ip!, i.mask!) === networkOf(a.ip, a.mask) && i.kind !== 'loopback');
      if (overlap && t.l3.kind !== 'loopback') return cli.err(`% ${networkOf(a.ip, a.mask)} overlaps with ${overlap.name}`);
      if (t.l3.dhcp) {
        cli.dev.dhcpClientFor(t.l3).stop();
        t.l3.dhcp = false;
      }
      t.l3.ip = a.ip;
      t.l3.mask = a.mask;
      if (t.l3.up) cli.dev.setTimer(10, () => cli.dev.stack.gratuitousArp(t.l3!));
    }
    cli.refresh();
    cli.dev.ospf?.interfaceChange();
  });
  c.add(IF_MODES, 'ip address dhcp', (cli) => {
    for (const t of cli.targets) {
      if (!t.l3) return cli.err("% Invalid input detected at '^' marker.");
      t.l3.dhcp = true;
      t.l3.ip = null;
      t.l3.mask = null;
      if (cli.dev.powered) cli.dev.dhcpClientFor(t.l3).start();
    }
    cli.refresh();
  });
  c.add(IF_MODES, 'ip address [<ip:ip>] [<mask:mask>]', (cli) => {
    for (const t of cli.targets) {
      if (!t.l3) continue;
      if (t.l3.dhcp) cli.dev.dhcpClientFor(t.l3).release();
      t.l3.dhcp = false;
      t.l3.ip = null;
      t.l3.mask = null;
    }
    cli.refresh();
  }, { no: 'only' });
  c.add(IF_MODES, 'ip helper-address <ip:ip>', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.l3) return;
      t.l3.helpers = t.l3.helpers.filter((h) => h !== a.ip);
      if (!a.no) t.l3.helpers.push(a.ip);
    }), { no: 'allow' });
  c.add(IF_MODES, 'ip nat {role:inside|outside}', (cli, a) =>
    cli.forTargets((t) => {
      if (t.l3) t.l3.natRole = a.no ? null : a.role;
    }), { no: 'allow' });
  c.add(IF_MODES, 'ip access-group <acl:word> {dir:in|out}', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.l3) return;
      if (a.dir === 'in') t.l3.aclIn = a.no ? null : a.acl;
      else t.l3.aclOut = a.no ? null : a.acl;
    }), { no: 'allow' });
  c.add(IF_MODES, 'ip ospf cost <c:num:1-65535>', (cli, a) =>
    cli.forTargets((t) => {
      if (t.l3) t.l3.ospfCost = a.no ? null : a.c;
      cli.dev.ospf?.interfaceChange();
    }), { no: 'allow' });
  c.add(IF_MODES, 'ip ospf priority <p:num:0-255>', (cli, a) => cli.forTargets((t) => t.l3 && (t.l3.ospfPriority = a.no ? 1 : a.p)), { no: 'allow' });
  c.add(IF_MODES, 'bandwidth <kbps:num:1-10000000>', (cli, a) =>
    cli.forTargets((t) => {
      if (t.l3) t.l3.bandwidthKbps = a.no ? (t.port?.maxSpeed ?? 1000) * 1000 : a.kbps;
      cli.dev.ospf?.interfaceChange();
    }), { no: 'allow' });
  c.add(IF_MODES, 'ip proxy-arp', (cli, a) => (cli.dev.stack.proxyArp = !a.no), { no: 'allow' });
  c.add(IF_MODES, 'mtu <m:num:64-9216>', () => {}, { no: 'allow' });
  c.add(IF_MODES, 'speed {s:10|100|1000|auto}', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.port) return;
      const v = a.no || a.s === 'auto' ? 'auto' : Number(a.s);
      if (v !== 'auto' && !t.port.speeds.includes(v)) return cli.err("% Invalid input detected at '^' marker.");
      t.port.speedSetting = v;
      cli.refresh();
    }), { no: 'allow' });
  c.add(IF_MODES, 'duplex {d:full|half|auto}', (cli, a) =>
    cli.forTargets((t) => {
      if (t.port) t.port.duplexSetting = a.no ? 'auto' : a.d;
    }), { no: 'allow' });
  c.add(IF_MODES, 'mdix auto', (cli, a) =>
    cli.forTargets((t) => {
      if (t.port && t.port.speeds.includes(100)) t.port.autoMdix = !a.no;
      cli.refresh();
    }), { no: 'allow' });
  c.add(IF_MODES, 'cdp enable', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.port) return;
      if (a.no) cli.dev.cdp.disabledPorts.add(t.port);
      else cli.dev.cdp.disabledPorts.delete(t.port);
    }), { no: 'allow' });
  c.add(IF_MODES, 'power inline {m:auto|never|static}', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.port || t.port.poeMaxW <= 0) return cli.err("% Invalid input detected at '^' marker.");
      t.port.poeEnabled = a.m !== 'never';
      cli.refresh();
    }));
  c.add(IF_MODES, 'mls qos trust {t:cos|dscp|device}', (cli, a) =>
    cli.forTargets((t) => {
      if (t.port) t.port.qosTrust = !a.no;
    }), { no: 'allow' });
  c.add(IF_MODES, 'auto qos voip {t:cisco-phone|trust}', (cli) => {
    cli.dev.qosEnabled = true;
    cli.forTargets((t) => t.port && (t.port.qosTrust = true));
  });
  c.add(IF_MODES, 'priority-queue out', (cli) => (cli.dev.qosEnabled = true));

  // subinterfeys
  c.add(['subif', 'if'], 'encapsulation dot1q|dot1Q <vlan:num:1-4094> [native]', (cli, a) =>
    cli.forTargets((t) => {
      if (!t.l3 || t.l3.kind !== 'subif') return cli.err("% Invalid input detected at '^' marker.");
      const dup = cli.dev.stack.interfaces.find((i) => i !== t.l3 && i.kind === 'subif' && i.port === t.l3!.port && i.encapVlan === a.vlan);
      if (dup) return cli.err(`% Configuration of multiple subinterfaces of the same main interface with the same VID (${a.vlan}) is not permitted. This VID is already configured on ${dup.name}.`);
      t.l3.encapVlan = a.vlan;
      t.l3.encapNative = !!a.native;
      cli.refresh();
    }));
  c.add(['subif', 'if'], 'switchport trunk encapsulation dot1q|isl|negotiate', (cli) => {
    if (!cli.sw || !cli.sw.isL3) return;
  });

  // switchport
  const spTargets = (cli: IosCli, fn: (p: Port) => void) => {
    let ok = true;
    cli.forTargets((t) => {
      if (!t.port || !t.port.switchport) {
        ok = false;
        return;
      }
      fn(t.port);
    });
    if (!ok) cli.err("% Invalid input detected at '^' marker.");
    cli.sw?.fabric.stp.sync();
    cli.refresh();
  };
  c.add(['if', 'if-range'], 'switchport mode {m:access|trunk}', (cli, a) =>
    spTargets(cli, (p) => {
      p.switchport!.mode = a.m;
      cli.sw!.fabric.computeOperMode(p);
      if (a.m === 'trunk') cli.sw!.fabric.sendDtp(p);
    }));
  c.add(['if', 'if-range'], 'switchport mode dynamic {m:auto|desirable}', (cli, a) =>
    spTargets(cli, (p) => {
      p.switchport!.mode = `dynamic ${a.m}` as any;
      cli.sw!.fabric.computeOperMode(p);
      cli.sw!.fabric.sendDtp(p);
    }));
  c.add(['if', 'if-range'], 'switchport mode', (cli) =>
    spTargets(cli, (p) => {
      p.switchport!.mode = 'dynamic auto';
      cli.sw!.fabric.computeOperMode(p);
    }), { no: 'only' });
  c.add(['if', 'if-range'], 'switchport nonegotiate', (cli, a) => spTargets(cli, (p) => (p.switchport!.nonegotiate = !a.no)), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport access vlan <v:num:1-4094>', (cli, a) =>
    spTargets(cli, (p) => {
      const f = cli.sw!.fabric;
      if (!f.vlans.has(a.v)) {
        cli.print(`% Access VLAN does not exist. Creating vlan ${a.v}`);
        f.createVlan(a.v);
      }
      f.flushPort(p);
      p.switchport!.accessVlan = a.v;
    }));
  c.add(['if', 'if-range'], 'switchport access vlan', (cli) => spTargets(cli, (p) => (p.switchport!.accessVlan = 1)), { no: 'only' });
  c.add(['if', 'if-range'], 'switchport voice vlan <v:num:1-4094>', (cli, a) =>
    spTargets(cli, (p) => {
      const f = cli.sw!.fabric;
      if (!f.vlans.has(a.v)) {
        cli.print(`% Voice VLAN does not exist. Creating vlan ${a.v}`);
        f.createVlan(a.v);
      }
      p.switchport!.voiceVlan = a.v;
      // CDP orqali telefonga darhol xabar berish
      cli.dev.cdp.advertise(p);
    }));
  c.add(['if', 'if-range'], 'switchport voice vlan', (cli) => spTargets(cli, (p) => (p.switchport!.voiceVlan = null)), { no: 'only' });
  c.add(['if', 'if-range'], 'switchport trunk native vlan <v:num:1-4094>', (cli, a) =>
    spTargets(cli, (p) => {
      p.switchport!.nativeVlan = a.v;
      cli.dev.cdp.advertise(p);
    }));
  c.add(['if', 'if-range'], 'switchport trunk native vlan', (cli) => spTargets(cli, (p) => (p.switchport!.nativeVlan = 1)), { no: 'only' });
  c.add(['if', 'if-range'], 'switchport trunk allowed vlan {op:add|remove|except} <list:vlanlist>', (cli, a) =>
    spTargets(cli, (p) => {
      const sp = p.switchport!;
      const list = parseVlanList(a.list)!;
      const cur = sp.allowedVlans === 'all' ? allVlans() : new Set(sp.allowedVlans);
      if (a.op === 'add') for (const v of list) cur.add(v);
      else if (a.op === 'remove') for (const v of list) cur.delete(v);
      else {
        const all = allVlans();
        for (const v of list) all.delete(v);
        sp.allowedVlans = all;
        return;
      }
      sp.allowedVlans = cur.size >= 4094 ? 'all' : cur;
    }));
  c.add(['if', 'if-range'], 'switchport trunk allowed vlan {op:all|none}', (cli, a) => spTargets(cli, (p) => (p.switchport!.allowedVlans = a.op === 'all' ? 'all' : new Set())));
  c.add(['if', 'if-range'], 'switchport trunk allowed vlan <list:vlanlist>', (cli, a) => spTargets(cli, (p) => (p.switchport!.allowedVlans = parseVlanList(a.list)!)));
  c.add(['if', 'if-range'], 'switchport trunk allowed vlan', (cli) => spTargets(cli, (p) => (p.switchport!.allowedVlans = 'all')), { no: 'only' });
  c.add(['if', 'if-range'], 'switchport trunk encapsulation {e:dot1q|isl|negotiate}', (cli, a) => {
    if (a.e === 'isl') cli.print('% ISL is not supported; using 802.1Q');
  });
  c.add(['if', 'if-range'], 'switchport port-security', (cli, a) =>
    spTargets(cli, (p) => {
      const sp = p.switchport!;
      if (!a.no && sp.mode !== 'access' && sp.mode !== 'trunk') {
        cli.err('Command rejected: ' + p.name + ' is a dynamic port.');
        return;
      }
      sp.portSecurity.enabled = !a.no;
      if (a.no) sp.portSecurity.secureMacs = [];
    }), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport port-security maximum <n:num:1-132>', (cli, a) => spTargets(cli, (p) => (p.switchport!.portSecurity.maximum = a.no ? 1 : a.n)), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport port-security violation {v:shutdown|restrict|protect}', (cli, a) => spTargets(cli, (p) => (p.switchport!.portSecurity.violation = a.no ? 'shutdown' : a.v)), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport port-security mac-address sticky', (cli, a) => spTargets(cli, (p) => (p.switchport!.portSecurity.sticky = !a.no)), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport port-security mac-address [sticky] <mac:mac>', (cli, a) =>
    spTargets(cli, (p) => {
      const ps = p.switchport!.portSecurity;
      ps.secureMacs = ps.secureMacs.filter((m) => m !== a.mac);
      if (!a.no) ps.secureMacs.push(a.mac);
    }), { no: 'allow' });
  c.add(['if', 'if-range'], 'spanning-tree portfast [trunk]', (cli, a) =>
    spTargets(cli, (p) => {
      p.switchport!.portfast = !a.no;
      if (!a.no && !cli.silent)
        cli.print(
          '%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION\n\n%Portfast has been configured on ' +
            p.name +
            ' but will only\n have effect when the interface is in a non-trunking mode.',
        );
    }), { no: 'allow' });
  c.add(['if', 'if-range'], 'spanning-tree bpduguard {e:enable|disable}', (cli, a) => spTargets(cli, (p) => (p.switchport!.bpduGuard = !a.no && a.e === 'enable')), { no: 'allow' });
  c.add(['if', 'if-range'], 'spanning-tree cost <c:num:1-200000000>', (cli, a) => spTargets(cli, (p) => (p.switchport!.stpCost = a.no ? null : a.c)), { no: 'allow' });
  c.add(['if', 'if-range'], 'spanning-tree port-priority <p:num:0-240>', (cli, a) => spTargets(cli, (p) => (p.switchport!.stpPortPriority = a.no ? 128 : a.p)), { no: 'allow' });
  c.add(['if', 'if-range'], 'switchport', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return cli.err("% Invalid input detected at '^' marker.");
    for (const t of cli.targets) {
      if (!t.port) continue;
      if (a.no) {
        if (!sw.isL3) return cli.err("% Invalid input detected at '^' marker.");
        sw.makeRouted(t.port);
        t.l3 = sw.stack.interfaces.find((i) => i.kind === 'physical' && i.port === t.port);
      } else {
        sw.makeSwitched(t.port);
        t.l3 = undefined;
      }
    }
    cli.refresh();
  }, { no: 'allow' });

  // ----------------------------------------------------------------- VLAN
  c.add('config', 'vlan <list:vlanlist>', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return cli.err("% Invalid input detected at '^' marker.");
    const list = [...parseVlanList(a.list)!];
    if (a.no) {
      for (const v of list) {
        if (v === 1 || v >= 1002) {
          cli.err(`%Default VLAN ${v} may not be deleted.`);
          continue;
        }
        sw.fabric.deleteVlan(v);
      }
      cli.refresh();
      return;
    }
    for (const v of list) {
      if (v >= 1002 && v <= 1005) {
        cli.err(`%Default VLAN ${v} may not be modified.`);
        return;
      }
      sw.fabric.createVlan(v);
    }
    cli.vlanCtx = list;
    cli.mode = 'vlan';
    cli.refresh();
  }, { no: 'allow' });
  c.add('vlan', 'name <name:word>', (cli, a) => {
    for (const v of cli.vlanCtx) {
      const info = cli.sw!.fabric.vlans.get(v);
      if (info) info.name = a.no ? `VLAN${String(v).padStart(4, '0')}` : a.name;
    }
  }, { no: 'allow' });
  c.add('vlan', 'state {s:active|suspend}', (cli, a) => {
    for (const v of cli.vlanCtx) {
      const info = cli.sw!.fabric.vlans.get(v);
      if (info) info.status = a.s === 'active' ? 'active' : 'suspended';
    }
    cli.sw!.fabric.onVlansChanged();
  });

  // ----------------------------------------------------------------- routing
  c.add('config', 'ip routing', (cli, a) => {
    if (cli.router) {
      if (a.no) cli.print('% IP routing cannot be disabled on this router in the simulator');
      return;
    }
    if (!cli.sw?.isL3) return cli.err("% Invalid input detected at '^' marker.");
    cli.dev.stack.opts.ipRouting = !a.no;
    cli.refresh();
  }, { no: 'allow' });
  c.add('config', 'ip default-gateway <ip:ip>', (cli, a) => {
    cli.dev.stack.defaultGateway = a.no ? null : a.ip;
    cli.refresh();
  }, { no: 'allow' });
  c.add('config', 'ip route <net:ip> <mask:mask> <nh:word> [<ad:num:1-255>] [permanent]', (cli, a) => {
    const stack = cli.dev.stack;
    if (!isValidMask(a.mask)) return cli.err('%Inconsistent address and mask');
    if (networkOf(a.net, a.mask) !== a.net) return cli.err('%Inconsistent address and mask');
    let nextHop: string | null = null;
    let ifaceName: string | null = null;
    if (isValidIp(a.nh)) nextHop = a.nh;
    else {
      const full = expandIfName(a.nh);
      if (!full || !stack.iface(full)) return cli.err("% Invalid input detected at '^' marker.");
      ifaceName = full;
    }
    const same = (r: { network: string; mask: string; nextHop: string | null; ifaceName: string | null }) => r.network === a.net && r.mask === a.mask && r.nextHop === nextHop && r.ifaceName === ifaceName;
    stack.staticRoutes = stack.staticRoutes.filter((r) => !same(r));
    if (!a.no) stack.staticRoutes.push({ network: a.net, mask: a.mask, nextHop, ifaceName, ad: a.ad ?? 1 });
    stack.invalidate();
    cli.dev.net.bump();
  }, { no: 'allow' });
  c.add('config', 'ip route <net:ip> <mask:mask> <iface:iface> <nh:ip> [<ad:num:1-255>]', (cli, a) => {
    const stack = cli.dev.stack;
    stack.staticRoutes = stack.staticRoutes.filter((r) => !(r.network === a.net && r.mask === a.mask && r.nextHop === a.nh));
    if (!a.no) stack.staticRoutes.push({ network: a.net, mask: a.mask, nextHop: a.nh, ifaceName: a.iface, ad: a.ad ?? 1 });
    stack.invalidate();
  }, { no: 'allow' });
  c.add('config', 'ip route <net:ip> <mask:mask>', (cli, a) => {
    cli.dev.stack.staticRoutes = cli.dev.stack.staticRoutes.filter((r) => !(r.network === a.net && r.mask === a.mask));
    cli.dev.stack.invalidate();
  }, { no: 'only' });

  c.add('config', 'router ospf <pid:num:1-65535>', (cli, a) => {
    const dev = cli.dev;
    if (!cli.router && !cli.sw?.isL3) return cli.err("% Invalid input detected at '^' marker.");
    if (a.no) {
      dev.ospf?.destroy();
      dev.ospf = null;
      return;
    }
    if (!dev.ospf) {
      dev.ospf = new OspfProcess(dev.stack, a.pid);
      if (dev.powered) dev.ospf.start();
    }
    cli.mode = 'router';
  }, { no: 'allow' });
  c.add('router', 'network <net:ip> <wild:wild> area <area:num:0-4294967295>', (cli, a) => {
    const o = cli.dev.ospf!;
    o.networks = o.networks.filter((n) => !(n.network === a.net && n.wildcard === a.wild));
    if (!a.no) o.networks.push({ network: a.net, wildcard: a.wild, area: a.area });
    o.interfaceChange();
  }, { no: 'allow' });
  c.add('router', 'router-id <rid:ip>', (cli, a) => {
    const o = cli.dev.ospf!;
    o.routerIdConfigured = a.no ? null : a.rid;
    cli.print('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
  }, { no: 'allow' });
  c.add('router', 'passive-interface <if:iface>', (cli, a) => {
    const o = cli.dev.ospf!;
    if (a.no) o.passive.delete(a.if);
    else o.passive.add(a.if);
  }, { no: 'allow' });
  c.add('router', 'passive-interface default', (cli, a) => (cli.dev.ospf!.passiveDefault = !a.no), { no: 'allow' });
  c.add('router', 'default-information originate', (cli, a) => {
    cli.dev.ospf!.defaultOriginate = !a.no;
    cli.dev.ospf!.originate();
  }, { no: 'allow' });
  c.add('router', 'auto-cost reference-bandwidth <bw:num:1-4294967>', (cli, a) => {
    cli.dev.ospf!.referenceBw = a.no ? 100 : a.bw;
    cli.dev.ospf!.interfaceChange();
  }, { no: 'allow' });
  c.add('router', 'log-adjacency-changes', () => {}, { no: 'allow' });

  // ----------------------------------------------------------------- DHCP
  c.add('config', 'ip dhcp pool <name:word>', (cli, a) => {
    const srv = cli.dev.dhcpServer;
    if (a.no) {
      srv.pools = srv.pools.filter((p) => p.name !== a.name);
      return;
    }
    let pool = srv.pools.find((p) => p.name === a.name);
    if (!pool) {
      pool = { name: a.name, network: '', mask: '', dns: [], leaseSec: 86400 };
      srv.pools.push(pool);
    }
    cli.poolCtx = pool;
    cli.mode = 'dhcp';
  }, { no: 'allow' });
  c.add('config', 'ip dhcp excluded-address <from:ip> [<to:ip>]', (cli, a) => {
    const srv = cli.dev.dhcpServer;
    const e = { from: a.from, to: a.to ?? a.from };
    srv.excluded = srv.excluded.filter((x) => !(x.from === e.from && x.to === e.to));
    if (!a.no) srv.excluded.push(e);
  }, { no: 'allow' });
  c.add('dhcp', 'network <net:ip> <mask:mask>', (cli, a) => {
    const p = cli.poolCtx!;
    p.network = networkOf(a.net, a.mask);
    p.mask = a.mask;
  });
  c.add('dhcp', 'default-router <ip:ip>', (cli, a) => (cli.poolCtx!.defaultRouter = a.no ? undefined : a.ip), { no: 'allow' });
  c.add('dhcp', 'dns-server <ip:ip> [<ip2:ip>]', (cli, a) => (cli.poolCtx!.dns = a.no ? [] : [a.ip, a.ip2].filter(Boolean)), { no: 'allow' });
  c.add('dhcp', 'domain-name <d:word>', (cli, a) => (cli.poolCtx!.domain = a.no ? undefined : a.d), { no: 'allow' });
  c.add('dhcp', 'lease <d:num:0-365> [<h:num:0-23>] [<m:num:0-59>]', (cli, a) => (cli.poolCtx!.leaseSec = a.d * 86400 + (a.h ?? 0) * 3600 + (a.m ?? 0) * 60));
  c.add('dhcp', 'lease infinite', (cli) => (cli.poolCtx!.leaseSec = 365 * 86400 * 10));
  c.add('dhcp', 'option 150 ip <ip:ip>', (cli, a) => (cli.poolCtx!.option150 = a.no ? undefined : a.ip), { no: 'allow' });

  // ----------------------------------------------------------------- ACL
  c.add('config', 'access-list <num:num:1-2699> <rest:line>', (cli, a) => {
    const n = String(a.num);
    const type = isStandardAclNumber(n) ? 'standard' : isExtendedAclNumber(n) ? 'extended' : null;
    if (!type) return cli.err("% Invalid input detected at '^' marker.");
    const e = parseAclEntry(tokenize(a.rest), type);
    if (typeof e === 'string') return cli.err(e);
    cli.dev.stack.acls.add(n, type, e);
  });
  c.add('config', 'access-list <num:num:1-2699>', (cli, a) => cli.dev.stack.acls.acls.delete(String(a.num)), { no: 'only' });
  c.add(ALL_CONFIG, 'ip access-list {type:standard|extended} <name:word>', (cli, a) => {
    if (a.no) {
      cli.dev.stack.acls.acls.delete(a.name);
      return;
    }
    cli.dev.stack.acls.ensure(a.name, a.type);
    cli.aclCtx = a.name;
    cli.mode = a.type === 'standard' ? 'std-nacl' : 'ext-nacl';
  }, { no: 'allow' });
  for (const m of ['std-nacl', 'ext-nacl'] as IosMode[]) {
    c.add(m, '[<seq:num:1-2147483647>] {act:permit|deny|remark} <rest:line>', (cli, a) => {
      const acl = cli.dev.stack.acls.get(cli.aclCtx!)!;
      const e = parseAclEntry([a.act, ...tokenize(a.rest)], acl.type);
      if (typeof e === 'string') return cli.err(e);
      cli.dev.stack.acls.add(acl.name, acl.type, { ...e, seq: a.seq });
    });
    c.add(m, '<seq:num:1-2147483647>', (cli, a) => {
      const acl = cli.dev.stack.acls.get(cli.aclCtx!)!;
      acl.entries = acl.entries.filter((e) => e.seq !== a.seq);
    }, { no: 'only' });
  }

  // ----------------------------------------------------------------- NAT
  c.add('config', 'ip nat inside source list <acl:word> interface <if:iface> [overload]', (cli, a) => {
    const nat = cli.dev.stack.nat;
    nat.rules = nat.rules.filter((r) => r.acl !== a.acl);
    if (!a.no) nat.rules.push({ acl: a.acl, iface: a.if, overload: !!a.overload });
  }, { no: 'allow' });
  c.add('config', 'ip nat inside source list <acl:word> pool <pool:word> [overload]', (cli, a) => {
    const nat = cli.dev.stack.nat;
    nat.rules = nat.rules.filter((r) => r.acl !== a.acl);
    if (!a.no) nat.rules.push({ acl: a.acl, pool: a.pool, overload: !!a.overload });
  }, { no: 'allow' });
  c.add('config', 'ip nat inside source static <local:ip> <global:ip>', (cli, a) => {
    const nat = cli.dev.stack.nat;
    nat.statics = nat.statics.filter((s) => s.local !== a.local || s.proto);
    if (!a.no) nat.statics.push({ local: a.local, global: a.global });
  }, { no: 'allow' });
  c.add('config', 'ip nat inside source static {proto:tcp|udp} <local:ip> <lport:num:1-65535> <global:ip> <gport:num:1-65535>', (cli, a) => {
    const nat = cli.dev.stack.nat;
    nat.statics = nat.statics.filter((s) => !(s.local === a.local && s.localPort === a.lport));
    if (!a.no) nat.statics.push({ local: a.local, global: a.global, proto: a.proto, localPort: a.lport, globalPort: a.gport });
  }, { no: 'allow' });
  c.add('config', 'ip nat pool <name:word> <start:ip> <end:ip> netmask <mask:mask>', (cli, a) => {
    const nat = cli.dev.stack.nat;
    if (a.no) nat.pools.delete(a.name);
    else nat.pools.set(a.name, { name: a.name, start: a.start, end: a.end, mask: a.mask });
  }, { no: 'allow' });

  // ----------------------------------------------------------------- line
  c.add('config', 'line {kind:console|vty} <a:num:0-15> [<b:num:0-15>]', (cli, a) => {
    cli.lineCtx = a.kind === 'console' ? 'con' : 'vty';
    cli.mode = 'line';
  });
  c.add('line', 'password [0|7] <pw:word>', (cli, a) => (lineCfg(cli).password = a['0|7'] === '7' ? decode7(a.pw) : a.pw));
  c.add('line', 'password', (cli) => (lineCfg(cli).password = null), { no: 'only' });
  c.add('line', 'login', (cli, a) => (lineCfg(cli).login = a.no ? 'none' : 'line'), { no: 'allow' });
  c.add('line', 'login local', (cli, a) => (lineCfg(cli).login = a.no ? 'none' : 'local'), { no: 'allow' });
  c.add('line', 'exec-timeout <m:num:0-35791> [<s:num:0-2147483>]', (cli, a) => (lineCfg(cli).execTimeout = a.m * 60 + (a.s ?? 0)));
  c.add('line', 'logging synchronous', (cli, a) => (lineCfg(cli).loggingSync = !a.no), { no: 'allow' });
  c.add('line', 'transport input {t:ssh|telnet|all|none}', (cli, a) => {
    lineCfg(cli).transport = a.t === 'all' ? ['telnet', 'ssh'] : a.t === 'none' ? [] : [a.t];
  });
  c.add('line', 'transport input telnet ssh', (cli) => (lineCfg(cli).transport = ['telnet', 'ssh']));
  c.add('line', 'transport input ssh telnet', (cli) => (lineCfg(cli).transport = ['telnet', 'ssh']));
  c.add('line', 'access-class <acl:word> in', (cli, a) => (lineCfg(cli).accessClass = a.no ? null : a.acl), { no: 'allow' });
  c.add('line', 'privilege level <l:num:0-15>', () => {});

  // ----------------------------------------------------------------- spanning-tree (global)
  c.add('config', 'spanning-tree mode {m:pvst|rapid-pvst|mst}', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return cli.err("% Invalid input detected at '^' marker.");
    sw.fabric.stp.mode = a.m === 'rapid-pvst' ? 'rapid-pvst' : 'pvst';
    for (const inst of sw.fabric.stp.instances.values()) for (const [, i] of inst.ports) i.state = i.state === 'forwarding' ? 'forwarding' : 'blocking';
    sw.fabric.stp.sync();
    cli.refresh();
  });
  c.add('config', 'spanning-tree vlan <list:vlanlist> priority <p:num:0-61440>', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return;
    if (a.p % 4096 !== 0) {
      cli.err('% Bridge Priority must be in increments of 4096.');
      cli.err('% Allowed values are:');
      cli.err('  0     4096  8192  12288 16384 20480 24576 28672');
      cli.err('  32768 36864 40960 45056 49152 53248 57344 61440');
      return;
    }
    for (const v of parseVlanList(a.list)!) sw.fabric.stp.priorities.set(v, a.p);
    sw.fabric.stp.sync();
    cli.refresh();
  });
  c.add('config', 'spanning-tree vlan <list:vlanlist> priority', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return;
    for (const v of parseVlanList(a.list)!) sw.fabric.stp.priorities.delete(v);
    sw.fabric.stp.sync();
  }, { no: 'only' });
  c.add('config', 'spanning-tree vlan <list:vlanlist> root {r:primary|secondary}', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return;
    for (const v of parseVlanList(a.list)!) sw.fabric.stp.priorities.set(v, a.r === 'primary' ? 24576 : 28672);
    sw.fabric.stp.sync();
    cli.refresh();
  });
  c.add('config', 'spanning-tree vlan <list:vlanlist>', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return;
    for (const v of parseVlanList(a.list)!) {
      if (a.no) sw.fabric.stp.disabledVlans.add(v);
      else sw.fabric.stp.disabledVlans.delete(v);
    }
    sw.fabric.stp.sync();
    cli.refresh();
  }, { no: 'allow' });
  c.add('config', 'spanning-tree portfast default', (cli, a) => {
    const sw = cli.sw;
    if (!sw) return;
    sw.fabric.stp.portfastDefault = !a.no;
    for (const p of sw.fabric.ports) if (p.switchport && p.switchport.mode === 'access') p.switchport.portfast = !a.no;
    sw.fabric.stp.sync();
  }, { no: 'allow' });
  c.add('config', 'spanning-tree portfast bpduguard default', (cli, a) => {
    if (cli.sw) cli.sw.fabric.stp.bpduGuardDefault = !a.no;
  }, { no: 'allow' });

  // ----------------------------------------------------------------- IP telefoniya (CME)
  c.add('config', 'telephony-service', (cli, a) => {
    const r = cli.router;
    if (!r || !r.modelInfo.cme) return cli.err("% Invalid input detected at '^' marker.");
    if (a.no) {
      r.cme.reset();
      return;
    }
    r.cme.enabled = true;
    r.cme.install();
    cli.mode = 'telephony';
  }, { no: 'allow' });
  c.add('telephony', 'max-ephones <n:num:0-250>', (cli, a) => (cli.router!.cme.maxEphones = a.n));
  c.add('telephony', 'max-dn <n:num:0-1500>', (cli, a) => (cli.router!.cme.maxDn = a.n));
  c.add('telephony', 'ip source-address <ip:ip> [port] [<port:num:2000-9999>]', (cli, a) => {
    const cme = cli.router!.cme;
    cme.sourceIp = a.ip;
    cme.port = a.port ?? 2000;
    cme.install();
  });
  c.add('telephony', 'auto assign <a:num:1-1500> to <b:num:1-1500>', (cli, a) => (cli.router!.cme.autoAssign = a.no ? null : { from: a.a, to: a.b }), { no: 'allow' });
  c.add('telephony', 'auto-reg-ephone', (cli, a) => (cli.router!.cme.autoRegEphone = !a.no), { no: 'allow' });
  c.add('telephony', 'create cnf-files', (cli) => cli.print('Creating CNF files'));
  c.add('telephony', 'system message <text:line>', () => {});
  c.add('config', 'ephone-dn <tag:num:1-1500>', (cli, a) => {
    const r = cli.router;
    if (!r?.cme.enabled) return cli.err("% Invalid input detected at '^' marker.");
    if (a.no) {
      r.cme.dns.delete(a.tag);
      return;
    }
    if (!r.cme.dns.has(a.tag)) {
      if (r.cme.dns.size >= r.cme.maxDn) return cli.err(`% Exceeded maximum number of directory numbers (max-dn ${r.cme.maxDn})`);
      r.cme.dns.set(a.tag, { tag: a.tag, number: '' });
      cli.dev.console(`%LINK-3-UPDOWN: Interface ephone_dsp DN ${a.tag}.1, changed state to up`);
    }
    cli.dnCtx = a.tag;
    cli.mode = 'ephone-dn';
  }, { no: 'allow' });
  c.add('ephone-dn', 'number <n:word>', (cli, a) => (cli.router!.cme.dns.get(cli.dnCtx)!.number = a.n));
  c.add('ephone-dn', 'name <n:line>', (cli, a) => (cli.router!.cme.dns.get(cli.dnCtx)!.name = a.n));
  c.add('ephone-dn', 'label <n:line>', (cli, a) => (cli.router!.cme.dns.get(cli.dnCtx)!.label = a.n));
  c.add('config', 'ephone <tag:num:1-250>', (cli, a) => {
    const r = cli.router;
    if (!r?.cme.enabled) return cli.err("% Invalid input detected at '^' marker.");
    if (a.no) {
      r.cme.ephones.delete(a.tag);
      return;
    }
    if (!r.cme.ephones.has(a.tag)) r.cme.ephones.set(a.tag, { tag: a.tag, mac: null, type: '7960', buttons: [], registered: false });
    cli.ephoneCtx = a.tag;
    cli.mode = 'ephone';
  }, { no: 'allow' });
  c.add('ephone', 'mac-address <mac:mac>', (cli, a) => (cli.router!.cme.ephones.get(cli.ephoneCtx)!.mac = a.mac));
  c.add('ephone', 'type <t:word>', (cli, a) => (cli.router!.cme.ephones.get(cli.ephoneCtx)!.type = a.t));
  c.add('ephone', 'button <spec:word>', (cli, a) => {
    const e = cli.router!.cme.ephones.get(cli.ephoneCtx)!;
    e.buttons = [];
    for (const part of String(a.spec).split(/[,]/)) {
      const m = part.match(/^(\d+):(\d+)$/);
      if (m) e.buttons.push({ button: Number(m[1]), dnTag: Number(m[2]) });
    }
  });
  c.add('ephone', 'restart|reset', (cli) => {
    const e = cli.router!.cme.ephones.get(cli.ephoneCtx)!;
    e.conn?.abort();
  });

  return c;
}

// =======================================================================================

function eraseStartup(cli: IosCli) {
  cli.ask('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', (a) => {
    if (a.toLowerCase().startsWith('n')) return;
    cli.dev.startupConfig = null;
    cli.print('[OK]');
    cli.print('Erase of nvram: complete');
    cli.dev.syslog('SYS', 7, 'NV_BLOCK_INIT', 'Initialized the geometry of nvram');
  });
}

function addLogHost(cli: IosCli, ip: string, no: boolean) {
  const l = cli.dev.ios.loggingHosts;
  const i = l.indexOf(ip);
  if (i >= 0) l.splice(i, 1);
  if (!no) l.push(ip);
}

function lineCfg(cli: IosCli) {
  return cli.lineCtx === 'con' ? cli.dev.ios.con : cli.dev.ios.vty;
}

function allVlans() {
  const s = new Set<number>();
  for (let i = 1; i <= 4094; i++) s.add(i);
  return s;
}

/** "fa0/1 - 24", "fa0/1-12, g0/1-2" */
export function expandRange(spec: string): string[] | null {
  const out: string[] = [];
  for (const part of spec.split(',')) {
    const p = part.replace(/\s+/g, '');
    if (!p) continue;
    const m = p.match(/^([a-zA-Z-]+)([\d/]*?)(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const [, pfx, mid, a, b] = m;
    const base = expandIfName(pfx + mid + a);
    if (!base) return null;
    const head = base.slice(0, base.length - a.length);
    const from = Number(a);
    const to = b ? Number(b) : from;
    if (to < from) return null;
    for (let i = from; i <= to; i++) out.push(head + i);
  }
  return out;
}

function bootBanner(dev: NetOsDevice): string {
  return [
    '',
    `System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)`,
    `Copyright (c) 1986-2019 by Cisco Systems, Inc.`,
    '',
    `Readonly ROMMON initialized`,
    `program load complete, entry point: 0x80803000, size: 0x1b340`,
    '',
    dev.iosVersion,
    '',
    dev.startupConfig ? '' : '--- System Configuration Dialog ---\n\nWould you like to enter the initial configuration dialog? [yes/no]: no',
    '',
    'Press RETURN to get started!',
    '',
  ].join('\n');
}

// --------------------------------------------------------------------------- ping/trace

function ping(cli: IosCli, a: Args) {
  const dev = cli.dev;
  const count = a.count ?? 5;
  const size = a.size ?? 100;
  let src: string | undefined;
  if (a.src) {
    if (isValidIp(a.src)) src = a.src;
    else {
      const i = dev.stack.iface(expandIfName(a.src) ?? a.src);
      if (!i?.ip) return cli.err('% Invalid source address- IP address not on any of our up interfaces');
      src = i.ip;
    }
  }
  const run = (ip: string) => {
    cli.print('Type escape sequence to abort.');
    cli.print(`Sending ${count}, ${size}-byte ICMP Echos to ${ip}, timeout is 2 seconds:`);
    if (src) cli.print(`Packet sent with a source address of ${src} `);
    let i = 0;
    let ok = 0;
    const rtts: number[] = [];
    let line = '';
    let cancelled = false;
    cli.runAsync(() => (cancelled = true));
    const ident = newIdent();
    const next = () => {
      if (cancelled) return;
      if (i >= count) {
        if (line) cli.out.write('\n');
        const pct = Math.round((ok / count) * 100);
        const stat = rtts.length ? `, round-trip min/avg/max = ${Math.round(Math.min(...rtts))}/${Math.round(rtts.reduce((x, y) => x + y, 0) / rtts.length)}/${Math.round(Math.max(...rtts))} ms` : '';
        cli.print(`Success rate is ${pct} percent (${ok}/${count})${stat}`);
        cli.finishAsync();
        return;
      }
      const seq = i++;
      pingOnce(dev, dev.stack, ip, { ident, seq, size: size - 28, timeoutMs: 2000, src }, (r) => {
        let ch = '.';
        if (r.kind === 'reply') {
          ch = '!';
          ok++;
          rtts.push(r.rtt);
        } else if (r.kind === 'unreachable') ch = 'U';
        else if (r.kind === 'ttl-exceeded') ch = '&';
        line += ch;
        cli.out.write(ch);
        // IOS: javoblar orasida kichik pauza
        dev.setTimer(r.kind === 'reply' ? 1 : 1, next);
      });
    };
    next();
  };
  resolveHost(cli, a.host, run);
}

function resolveHost(cli: IosCli, host: string, run: (ip: string) => void) {
  if (isValidIp(host)) return run(host);
  const dev = cli.dev;
  const h = dev.ios.ipHosts.get(host);
  if (h) return run(h);
  if (!dev.ios.domainLookup || !dev.stack.dnsServers.length) {
    cli.print(`Translating "${host}"${dev.ios.domainLookup ? '...domain server (255.255.255.255)' : ''}`);
    cli.print('% Unrecognized host or address, or protocol not running.');
    cli.print('');
    return;
  }
  cli.print(`Translating "${host}"...domain server (${dev.stack.dnsServers[0]}) [OK]`);
  cli.runAsync(() => {});
  dev.resolver.resolve(host, (ip) => {
    cli.finishAsync();
    if (!ip) {
      cli.print('% Unrecognized host or address, or protocol not running.');
      return;
    }
    run(ip);
  });
}

function trace(cli: IosCli, host: string) {
  const dev = cli.dev;
  resolveHost(cli, host, (ip) => {
    cli.print('Type escape sequence to abort.');
    cli.print(`Tracing the route to ${ip}`);
    cli.print('VRF info: (vrf in name/id, vrf out name/id)');
    let lastFrom = '';
    const cancel = traceroute(
      dev,
      dev.stack,
      ip,
      { mode: 'udp', maxHops: 30, probes: 3, timeoutMs: 3000 },
      (h) => {
        let s = `  ${String(h.ttl).padStart(2)} `;
        for (const p of h.probes) {
          if (!p) s += '* ';
          else {
            if (p.from !== lastFrom) {
              s += `${p.from} `;
              lastFrom = p.from;
            }
            s += `${Math.max(0, Math.round(p.rtt))} msec `;
          }
        }
        cli.print(s.trimEnd());
      },
      () => cli.finishAsync(),
    );
    cli.runAsync(cancel);
  });
}

export { type5, type7, formatVlanList, shortIfName, wildcardToMask };
