// Kommutatorlar: Catalyst 2960 (L2), 3560/3650 (L3 multilayer).
import { NetOsDevice, defaultIos } from './netos';
import { SWITCH_MODELS, SwitchModel } from './models';
import { SwitchFabric } from '../switching';
import { defaultSwitchport } from '../port';
import type { Port } from '../port';
import { IosCli } from '../cli/ios';
import { generateRunningConfig } from '../cli/running-config';
import type { DeviceKind } from '../device';

export class Switch extends NetOsDevice {
  readonly kind: DeviceKind;
  modelInfo: SwitchModel;
  platform: string;
  capabilities: string;
  iosVersion: string;
  iosImage: string;
  declare fabric: SwitchFabric;

  constructor(modelId = '2960-24TT', label = 'Switch0', id?: string) {
    const m = SWITCH_MODELS[modelId] ?? SWITCH_MODELS['2960-24TT'];
    super(m.id, 'Switch', id);
    this.label = label;
    this.modelInfo = m;
    this.kind = m.layer3 ? 'l3switch' : 'switch';
    this.platform = m.platform;
    this.capabilities = m.layer3 ? 'R S I' : 'S I';
    this.iosImage = m.image;
    this.iosVersion = m.id.startsWith('3650')
      ? 'Cisco IOS XE Software, Version 16.03.07'
      : `Cisco IOS Software, ${m.id.startsWith('3560') ? 'C3560' : 'C2960'} Software (${m.id.startsWith('3560') ? 'C3560-IPSERVICESK9-M' : 'C2960-LANBASEK9-M'}), Version 15.0(2)SE4`;
    this.procDelayMs = 0.01;
    this.poeBudgetW = m.poeBudgetW;
    for (const spec of m.ports) this.addPort(spec, '00:1a:2b');
    this.fabric = new SwitchFabric(this, this.baseMac);
    this.fabric.deliverToSvi = (svi, f) => this.stack.receiveFrame(svi, f);
    for (const p of this.ports) if (p.media !== 'console') this.fabric.addPort(p);
    this.factoryReset();
  }

  get isL3() {
    return this.modelInfo.layer3;
  }

  factoryReset() {
    this.hostname = 'Switch';
    this.ios = defaultIos();
    const f = this.fabric;
    for (const v of [...f.vlans.keys()]) if (v !== 1 && v < 1002) f.vlans.delete(v);
    f.vlans.get(1)!.name = 'default';
    f.macTable.clear();
    f.stp.mode = 'pvst';
    f.stp.enabled = true;
    f.stp.priorities.clear();
    f.stp.disabledVlans.clear();
    f.stp.portfastDefault = false;
    f.stp.bpduGuardDefault = false;
    f.vtpDomain = '';
    f.vtpMode = 'transparent';
    this.stack.staticRoutes = [];
    this.stack.acls.acls.clear();
    this.stack.defaultGateway = null;
    this.stack.dnsServers = [];
    this.stack.opts.ipRouting = false;
    this.dhcpServer.pools = [];
    this.dhcpServer.excluded = [];
    this.dhcpServer.bindings.clear();
    for (const c of this.dhcpClients) c.stop();
    this.dhcpClients = [];
    this.ospf?.destroy();
    this.ospf = null;
    this.qosEnabled = false;
    for (const i of [...this.stack.interfaces]) this.stack.removeInterface(i);
    for (const v of [...f.svis.keys()]) this.removeSvi(v);
    for (const p of this.ports) {
      if (p.media === 'console') continue;
      p.switchport = defaultSwitchport('dynamic auto');
      p.adminUp = true;
      p.description = '';
      p.speedSetting = 'auto';
      p.duplexSetting = 'auto';
      p.errDisabled = null;
      p.poeEnabled = true;
      p.qosTrust = false;
    }
    const v1 = this.ensureSvi(1);
    v1.adminUp = false;
    this.stack.invalidate();
    this.net?.refresh();
  }

  /** L3 kommutatorda `no switchport` — portni routed portga aylantirish */
  makeRouted(p: Port) {
    if (!this.isL3 || !p.switchport) return false;
    p.switchport = null;
    this.fabric.flushPort(p);
    const i = this.makePhysicalIface(p);
    i.adminUp = p.adminUp;
    this.stack.addInterface(i);
    this.sortInterfaces();
    this.fabric.stp.sync();
    this.net.refresh();
    return true;
  }

  makeSwitched(p: Port) {
    if (p.switchport) return;
    const i = this.stack.interfaces.find((x) => x.kind === 'physical' && x.port === p);
    if (i) this.stack.removeInterface(i);
    p.switchport = defaultSwitchport('dynamic auto');
    this.fabric.stp.sync();
    this.net.refresh();
  }

  applyConfig(text: string): string[] {
    return IosCli.replay(this, text);
  }

  runningConfig(): string {
    return generateRunningConfig(this);
  }
}
