// Qurilma terminal sessiyalarini saqlash (oyna yopilib ochilganda tarix yo'qolmasligi uchun).
import type { Device } from '../engine/device';
import type { TerminalSession } from '../engine/cli/terminal';
import { IosCli } from '../engine/cli/ios';
import { HostShell, openConsole } from '../engine/cli/hostshell';
import type { NetOsDevice } from '../engine/devices/netos';
import type { Host } from '../engine/devices/host';

const cache = new Map<string, { s: TerminalSession; closed: boolean; bootedAt: number }>();

function get(key: string, dev: Device, make: () => TerminalSession | string): TerminalSession | string {
  const c = cache.get(key);
  if (c && !c.closed && c.bootedAt === dev.bootedAt && dev.powered) return c.s;
  const s = make();
  if (typeof s === 'string') return s;
  const entry = { s, closed: false, bootedAt: dev.bootedAt };
  s.onClose?.(() => (entry.closed = true));
  cache.set(key, entry);
  return s;
}

export function iosSession(dev: NetOsDevice): TerminalSession {
  return get(`ios:${dev.id}`, dev, () => new IosCli(dev, 'con')) as TerminalSession;
}

export function shellSession(dev: Host): TerminalSession {
  return get(`sh:${dev.id}`, dev, () => new HostShell(dev)) as TerminalSession;
}

export function consoleSession(dev: Host): TerminalSession | string {
  const rs = dev.ports.find((p) => p.media === 'console');
  const peer = rs?.peer?.device;
  return get(`con:${dev.id}:${peer?.id ?? ''}`, peer ?? dev, () => openConsole(dev));
}

export function resetSessions() {
  cache.clear();
}
