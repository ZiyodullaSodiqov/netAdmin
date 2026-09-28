// Qurilma turini aniqlash (aylanma importlarsiz).
import type { Device } from '../device';
import type { Router } from './router';
import type { Switch } from './switch';

export function isRouter(d: Device | null | undefined): d is Router {
  return !!d && d.kind === 'router';
}

export function isSwitch(d: Device | null | undefined): d is Switch {
  return !!d && (d.kind === 'switch' || d.kind === 'l3switch');
}
