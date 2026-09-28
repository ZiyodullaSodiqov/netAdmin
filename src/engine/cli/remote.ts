// Telnet (TCP 23) va SSH (TCP 22) — masofaviy boshqaruv.
import type { Device } from '../device';
import type { IpStack } from '../ipstack';
import type { DnsResolver } from '../protocols/dns';
import type { NetOsDevice } from '../devices/netos';
import type { TcpConn } from '../protocols/tcp';
import type { TerminalData, IPv4Packet } from '../packets';
import { OutputBus, TerminalSession } from './terminal';
import { IosCli } from './ios';
import { type5 } from './crypto';

function term(text: string, secure: boolean, extra: Partial<TerminalData> = {}): TerminalData {
  return { kind: 'term', text, size: Math.max(1, text.length) + (secure ? 36 : 0), secure, ...extra };
}

/** Mijoz tomoni */
export function openRemoteTerminal(
  dev: Device,
  stack: IpStack,
  resolver: DnsResolver,
  host: string,
  proto: 'telnet' | 'ssh',
  user: string | undefined,
  cbs: { onOpen: (s: TerminalSession) => void; onError: (msg: string) => void },
) {
  resolver.resolve(host, (ip) => {
    if (!ip) {
      cbs.onError(`% Unknown host ${host}`);
      return;
    }
    const secure = proto === 'ssh';
    const bus = new OutputBus();
    const closeFns: (() => void)[] = [];
    let secret = false;
    let closed = false;
    let conn: TcpConn | null = null;
    const session: TerminalSession = {
      history: [],
      prompt: () => '',
      input: (line: string) => {
        if (closed || !conn) return;
        if (!secret) session.history.push(line);
        conn.send(term(line, secure));
      },
      interrupt: () => conn?.send(term('', secure, { interrupt: true })),
      isSecret: () => secret,
      isBusy: () => false,
      onOutput: (fn) => {
        const b = bus.buffer.splice(0);
        const u = bus.on(fn);
        for (const x of b) fn(x);
        return u;
      },
      onClose: (fn) => closeFns.push(fn),
      close: () => conn?.close(),
    };
    let opened = false;
    conn = stack.tcp.connect(ip, proto === 'ssh' ? 22 : 23, {
      onOpen: (c) => {
        opened = true;
        if (secure) c.send(term(`SSH-2.0-Cisco-1.25 user=${user ?? ''}`, true, { size: 300 } as any));
        cbs.onOpen(session);
      },
      onData: (_c, msg) => {
        if (msg.kind !== 'term') return;
        secret = !!msg.secretInput;
        if (msg.text) bus.write(msg.text);
      },
      onClose: (_c, reason) => {
        if (closed) return;
        closed = true;
        if (!opened) {
          if (reason === 'refused') cbs.onError('% Connection refused by remote host');
          else if (reason === 'timeout') cbs.onError('% Connection timed out; remote host not responding');
          else cbs.onError('% Destination unreachable; gateway or host down');
          return;
        }
        for (const f of closeFns) f();
      },
    });
    if (!conn) cbs.onError('% No route to host');
  });
}

/** Server tomoni: router/switch VTY liniyalari */
export function installVtyServer(dev: NetOsDevice) {
  const stack = dev.stack;
  const accept = (proto: 'telnet' | 'ssh') => (c: TcpConn) => {
    const vty = dev.ios.vty;
    if (!vty.transport.includes(proto)) return null;
    if (proto === 'ssh' && !dev.ios.rsaBits) return null;
    const vtyCount = [...dev.sessions].filter((s) => s.line === 'vty').length;
    if (vtyCount >= 5) return null;
    if (vty.accessClass) {
      const fake: IPv4Packet = { kind: 'ipv4', src: c.remoteIp, dst: c.localIp, ttl: 64, protocol: 'TCP', id: 0, dscp: 0, payload: { kind: 'tcp', srcPort: c.remotePort, dstPort: c.localPort, seq: 0, ack: 0, flags: { syn: true }, window: 0, dataSize: 0 } };
      if (!stack.acls.permits(vty.accessClass, fake)) return null;
    }
    const secure = proto === 'ssh';
    let cli: IosCli | null = null;
    let pendingOut = '';
    let flushTimer: any = null;
    const flush = () => {
      flushTimer = null;
      if (!pendingOut && !cli) return;
      c.send(term(pendingOut, secure, { secretInput: cli ? cli.isSecret() : true }));
      pendingOut = '';
    };
    const write = (t: string) => {
      pendingOut += t;
      if (!flushTimer) flushTimer = dev.setTimer(0.2, flush);
    };
    const startCli = (skipLogin: boolean, user?: string) => {
      cli = new IosCli(dev, 'vty', { skipLogin, from: c.remoteIp });
      if (user) for (const s of dev.sessions) if (s.from === c.remoteIp && s.line === 'vty') s.user = user;
      cli.onOutput(write);
      cli.onClose(() => {
        dev.setTimer(1, () => {
          flush();
          c.close();
        });
      });
      if (skipLogin) {
        const u = dev.ios.users.find((x) => x.name === user);
        if (u && u.privilege >= 15) cli.mode = 'priv';
        write('\n' + cli.prompt());
      }
    };
    // SSH autentifikatsiya holati
    let sshUser: string | undefined;
    let sshTries = 0;
    let sshAuthed = false;
    return {
      onOpen: () => {
        if (!secure) startCli(false);
      },
      onData: (_c: TcpConn, msg: any) => {
        if (msg.kind !== 'term') return;
        if (msg.interrupt) {
          cli?.interrupt();
          return;
        }
        if (secure && !sshAuthed) {
          if (msg.text.startsWith('SSH-2.0')) {
            sshUser = msg.text.split('user=')[1] || undefined;
            c.send(term('Password: ', true, { secretInput: true }));
            return;
          }
          const u = dev.ios.users.find((x) => x.name === sshUser);
          const ok = u && ((u.secret && u.secret === type5(msg.text)) || (u.password !== undefined && u.password === msg.text));
          const lineOk = dev.ios.vty.login === 'line' && dev.ios.vty.password === msg.text && !sshUser;
          if (ok || lineOk) {
            sshAuthed = true;
            c.send(term('\n', true));
            startCli(true, sshUser);
          } else if (++sshTries >= 3) {
            c.send(term('\n% Authentication failed.\n', true));
            dev.setTimer(5, () => c.close());
          } else c.send(term('\nPassword: ', true, { secretInput: true }));
          return;
        }
        cli?.input(msg.text);
        if (cli && !flushTimer) flushTimer = dev.setTimer(0.2, flush);
      },
      onClose: () => {
        cli?.close();
      },
    };
  };
  stack.tcp.listen(23, accept('telnet'));
  stack.tcp.listen(22, accept('ssh'));
}
