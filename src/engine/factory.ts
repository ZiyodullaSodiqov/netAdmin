// Qurilmalar katalogi, yaratish va topologiyani saqlash/yuklash (JSON).
import type { Device } from './device';
import { Network } from './network';
import { Router } from './devices/router';
import { Switch } from './devices/switch';
import { Host, HostKind } from './devices/host';
import { IpPhone } from './devices/ipphone';
import { AccessPoint, HomeRouter } from './devices/wireless';
import { ROUTER_MODELS, SWITCH_MODELS } from './devices/models';
import type { CableType } from './link';
import { bumpMacCounter } from './util';

export type DeviceType =
  | 'router-2911'
  | 'router-4331'
  | 'router-1841'
  | 'switch-2960-24TT'
  | 'switch-2960-24PS'
  | 'switch-3560-24PS'
  | 'switch-3650-24PS'
  | 'pc'
  | 'laptop'
  | 'server'
  | 'smartphone'
  | 'printer'
  | 'ipphone'
  | 'accesspoint'
  | 'homerouter';

export interface CatalogItem {
  type: DeviceType;
  category: 'Routerlar' | 'Kommutatorlar' | 'Simsiz' | 'Oxirgi qurilmalar' | 'Telefoniya';
  name: string;
  description: string;
  prefix: string;
}

export const CATALOG: CatalogItem[] = [
  ...Object.values(ROUTER_MODELS).map((m) => ({ type: `router-${m.id}` as DeviceType, category: 'Routerlar' as const, name: m.name, description: m.description, prefix: 'Router' })),
  ...Object.values(SWITCH_MODELS).map((m) => ({ type: `switch-${m.id}` as DeviceType, category: 'Kommutatorlar' as const, name: m.name, description: m.description, prefix: m.layer3 ? 'MLS' : 'Switch' })),
  { type: 'accesspoint', category: 'Simsiz', name: 'Access Point (Wi-Fi 5)', description: "Korporativ kirish nuqtasi: 2.4 + 5 GHz, SSID->VLAN, PoE (802.3af) bilan ishlaydi", prefix: 'AP' },
  { type: 'homerouter', category: 'Simsiz', name: 'Uy Wi-Fi routeri', description: 'WAN (Internet) + 4 LAN + Wi-Fi, DHCP, NAT, DNS proksi, port forwarding', prefix: 'WiFiRouter' },
  { type: 'ipphone', category: 'Telefoniya', name: 'IP telefon 7960', description: "SW (PoE) va PC portlari, Voice VLAN (CDP), CallManager Express bilan SCCP", prefix: 'Phone' },
  { type: 'pc', category: 'Oxirgi qurilmalar', name: 'Kompyuter (PC)', description: "FastEthernet0 + RS-232 konsol porti, Windows 10", prefix: 'PC' },
  { type: 'laptop', category: 'Oxirgi qurilmalar', name: 'Noutbuk', description: 'FastEthernet0 + Wi-Fi, Windows 10', prefix: 'Laptop' },
  { type: 'server', category: 'Oxirgi qurilmalar', name: 'Server', description: '2×Gigabit, Linux: HTTP/HTTPS, DNS, DHCP, Syslog + CPU/RAM yuklama modeli', prefix: 'Server' },
  { type: 'smartphone', category: 'Oxirgi qurilmalar', name: 'Smartfon', description: 'Faqat Wi-Fi, Android', prefix: 'Phone-M' },
  { type: 'printer', category: 'Oxirgi qurilmalar', name: 'Printer', description: 'Tarmoq printeri, FastEthernet0', prefix: 'Printer' },
];

export function createDevice(type: DeviceType, label: string, id?: string): Device {
  if (type.startsWith('router-')) return new Router(type.slice(7), label, id);
  if (type.startsWith('switch-')) return new Switch(type.slice(7), label, id);
  switch (type) {
    case 'ipphone':
      return new IpPhone(label, id);
    case 'accesspoint':
      return new AccessPoint(label, id);
    case 'homerouter':
      return new HomeRouter(label, id);
    default:
      return new Host(type as HostKind, label, id);
  }
}

export function deviceType(d: Device): DeviceType {
  if (d.kind === 'router') return `router-${(d as Router).modelInfo.id}` as DeviceType;
  if (d.kind === 'switch' || d.kind === 'l3switch') return `switch-${(d as Switch).modelInfo.id}` as DeviceType;
  return d.kind as DeviceType;
}

export function nextLabel(net: Network, type: DeviceType): string {
  const prefix = CATALOG.find((c) => c.type === type)?.prefix ?? 'Device';
  let i = 0;
  while (net.devices.some((d) => d.label === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// ---------------------------------------------------------------------- topologiya fayli

export interface TopologyFile {
  format: 'netadmin-school';
  version: 1;
  name: string;
  description?: string;
  simTimeMs?: number;
  devices: {
    id: string;
    type: DeviceType;
    label: string;
    x: number;
    y: number;
    floor?: number;
    building?: string;
    powerSwitch: boolean;
    acPower: boolean;
    macs: string[];
    config: any;
    notes?: string;
  }[];
  cables: { id: string; type: CableType; a: { device: string; port: string }; b: { device: string; port: string }; lengthM?: number | null }[];
  walls?: Network['walls'];
}

export function saveTopology(net: Network, name = 'Topologiya'): TopologyFile {
  return {
    format: 'netadmin-school',
    version: 1,
    name,
    simTimeMs: net.sim.now,
    devices: net.devices.map((d) => ({
      id: d.id,
      type: deviceType(d),
      label: d.label,
      x: d.x,
      y: d.y,
      floor: d.floor,
      building: d.building,
      powerSwitch: d.powerSwitch,
      acPower: d.acPower,
      macs: d.ports.map((p) => p.mac),
      config: d.saveConfig(),
      notes: d.notes || undefined,
    })),
    cables: net.cables.map((c) => ({ id: c.id, type: c.type, a: { device: c.a.device.id, port: c.a.name }, b: { device: c.b.device.id, port: c.b.name }, lengthM: c.manualLengthM })),
    walls: net.walls,
  };
}

export function loadTopology(file: TopologyFile, net = new Network()): Network {
  if (file.format !== 'netadmin-school') throw new Error('Noto\'g\'ri fayl formati');
  net.walls = file.walls ?? [];
  // Avval qurilmalar (o'chiq holatda), keyin kabellar, keyin quvvat
  const created: [Device, TopologyFile['devices'][number]][] = [];
  for (const dd of file.devices) {
    const d = createDevice(dd.type, dd.label, dd.id);
    dd.macs?.forEach((m, i) => {
      if (d.ports[i]) {
        d.ports[i].mac = m;
        bumpMacCounter(m);
      }
    });
    // L3 interfeyslar port MAC larini ishlatadi — yangilash
    for (const i of ((d as any).stack?.interfaces ?? []) as any[]) if (i.port && (i.kind === 'physical' || i.kind === 'host' || i.kind === 'subif')) i.mac = i.port.mac;
    d.floor = dd.floor ?? 0;
    d.building = dd.building ?? '';
    d.notes = dd.notes ?? '';
    d.powerSwitch = false;
    d.acPower = dd.acPower;
    net.addDevice(d, dd.x, dd.y);
    created.push([d, dd]);
  }
  for (const c of file.cables) {
    const a = net.device(c.a.device)?.port(c.a.port);
    const b = net.device(c.b.device)?.port(c.b.port);
    if (!a || !b) continue;
    const r = net.connect(a, b, c.type, c.id);
    if (typeof r !== 'string' && c.lengthM != null) r.manualLengthM = c.lengthM;
  }
  for (const [d, dd] of created) d.powerSwitch = dd.powerSwitch;
  net.refresh();
  for (const [d, dd] of created) d.loadConfig(dd.config);
  net.refresh();
  return net;
}
