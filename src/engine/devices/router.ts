// Router (ISR 2911 / 4331 / 1841).
import { NetOsDevice, defaultIos } from './netos';
import { ROUTER_MODELS, RouterModel } from './models';
import { CallManager } from '../protocols/cme';
import { IosCli } from '../cli/ios';
import { generateRunningConfig } from '../cli/running-config';
import type { DeviceKind } from '../device';

export class Router extends NetOsDevice {
  readonly kind: DeviceKind = 'router';
  modelInfo: RouterModel;
  cme: CallManager;
  platform: string;
  capabilities = 'R B S I';
  iosVersion: string;
  iosImage: string;

  constructor(modelId = '2911', label = 'Router0', id?: string) {
    const m = ROUTER_MODELS[modelId] ?? ROUTER_MODELS['2911'];
    super(m.id, 'Router', id);
    this.label = label;
    this.modelInfo = m;
    this.platform = m.platform;
    this.iosImage = m.image;
    this.iosVersion = m.id === '4331' ? 'Cisco IOS XE Software, Version 16.09.04' : m.id === '1841' ? 'Cisco IOS Software, 1841 Software (C1841-ADVIPSERVICESK9-M), Version 12.4(15)T1' : 'Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.5(3)M4a';
    this.procDelayMs = 0.08;
    for (const spec of m.ports) this.addPort(spec, '00:d0:97');
    this.stack.opts.ipRouting = true;
    this.cme = new CallManager(this.stack);
    for (const p of this.ports) {
      if (p.media === 'console') continue;
      const i = this.makePhysicalIface(p);
      this.stack.addInterface(i);
    }
    this.factoryReset();
  }

  factoryReset() {
    this.hostname = 'Router';
    this.ios = defaultIos();
    this.stack.staticRoutes = [];
    this.stack.acls.acls.clear();
    this.stack.nat.statics = [];
    this.stack.nat.rules = [];
    this.stack.nat.pools.clear();
    this.stack.nat.entries = [];
    this.stack.dnsServers = [];
    this.stack.routeProviders = this.stack.routeProviders.filter((p) => !(p as any).dhcp);
    this.dhcpServer.pools = [];
    this.dhcpServer.excluded = [];
    this.dhcpServer.bindings.clear();
    for (const c of this.dhcpClients) c.stop();
    this.dhcpClients = [];
    this.ospf?.destroy();
    this.ospf = null;
    this.cme.reset();
    this.qosEnabled = false;
    // subinterfeys va loopbacklarni o'chirish
    for (const i of [...this.stack.interfaces]) if (i.kind !== 'physical') this.stack.removeInterface(i);
    for (const i of this.stack.interfaces) {
      i.ip = null;
      i.mask = null;
      i.dhcp = false;
      i.dhcpState = null;
      i.helpers = [];
      i.natRole = null;
      i.aclIn = null;
      i.aclOut = null;
      i.description = '';
      i.ospfCost = null;
      i.bandwidthKbps = (i.port?.maxSpeed ?? 1000) * 1000;
    }
    for (const p of this.ports) {
      p.adminUp = p.media === 'console';
      p.description = '';
      p.speedSetting = 'auto';
      p.duplexSetting = 'auto';
      p.errDisabled = null;
    }
    for (const i of this.stack.interfaces) i.adminUp = i.port ? i.port.adminUp : true;
    this.stack.invalidate();
    this.net?.refresh();
  }

  applyConfig(text: string): string[] {
    return IosCli.replay(this, text);
  }

  runningConfig(): string {
    return generateRunningConfig(this);
  }

  tick1s() {
    super.tick1s();
    this.cme.tick();
  }
}
