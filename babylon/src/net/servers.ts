import { ServerMsg } from './protocol';

export interface BuiltinServer {
  id: string;
  name: string;
  region: string;
  webHost: string;
  webPort: number;
}

export const BUILTIN_SERVERS: BuiltinServer[] = [
  { id: 'srv-ru', name: 'Россия', region: 'ru', webHost: 'rudigitalgame.fimdi.ru', webPort: 6767 },
  { id: 'srv-ru2', name: 'Россия 2', region: 'ru', webHost: 'lvdigitalgame.fimdi.ru', webPort: 6767 },
];

const DEV_HOST_KEY = 'dg.devHost';

export interface ServerRef {
  id: string;
  name: string;
  region: string;
  wsUrl: string;
  isDev: boolean;
}

export function parseDevHostParam(): { host: string; port: string; proto: 'ws' | 'wss' } | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('server');
  if (!raw) return null;
  let proto: 'ws' | 'wss' = 'ws';
  let [host, port] = raw.split(':');
  if (host?.startsWith('//')) host = host.slice(2);
  if (host?.endsWith('s')) {
    if (host.endsWith('wss://')) proto = 'wss';
    host = host.replace(/^wss:\/\//, '').replace(/^ws:\/\//, '');
  }
  if (raw.startsWith('wss://')) proto = 'wss';
  if (host.includes('://')) host = host.split('://')[1];
  port = port || '6767';
  return { host, port, proto };
}

export function savedDevHost(): { host: string; port: string; proto: 'ws' | 'wss' } | null {
  const raw = localStorage.getItem(DEV_HOST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { host: string; port: string; proto: 'ws' | 'wss' };
    return parsed;
  } catch {
    return null;
  }
}

export function saveDevHost(ref: { host: string; port: string; proto: 'ws' | 'wss' } | null): void {
  if (ref) localStorage.setItem(DEV_HOST_KEY, JSON.stringify(ref));
  else localStorage.removeItem(DEV_HOST_KEY);
}

function wsUrlFor(ref: { host: string; port: string | number; proto: string }): string {
  return `${ref.proto}://${ref.host}:${ref.port}`;
}

export function listServerRefs(): ServerRef[] {
  const out: ServerRef[] = [];
  const dev = parseDevHostParam() ?? savedDevHost();
  if (dev) {
    out.push({ id: 'dev', name: `dev (${dev.host}:${dev.port})`, region: 'dev', wsUrl: wsUrlFor(dev), isDev: true });
  }
  for (const b of BUILTIN_SERVERS) {
    out.push({ id: b.id, name: b.name, region: b.region, wsUrl: wsUrlFor({ host: b.webHost, port: b.webPort, proto: 'wss' }), isDev: false });
  }
  return out;
}

export function serverRefById(id: string): ServerRef {
  return listServerRefs().find((s) => s.id === id) ?? listServerRefs()[0];
}

export type ServerIdentity = ServerMsg;
