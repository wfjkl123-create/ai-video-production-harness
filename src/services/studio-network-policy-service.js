import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

function stripIpv6Brackets(value) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function normalizeRemoteAddress(value) {
  const address = String(value ?? '').trim();
  if (address.startsWith('::ffff:')) return address.slice(7);
  return stripIpv6Brackets(address.split('%')[0]);
}

export function isPrivateLanAddress(value) {
  const address = normalizeRemoteAddress(value);
  if (address === '127.0.0.1' || address === '::1') return true;
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower);
  }
  return false;
}

export function parseHostHeader(value) {
  const host = String(value ?? '').trim();
  if (!host || host.length > 255 || /[\s/@\\]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { hostname: stripIpv6Brackets(url.hostname.toLowerCase()), port: url.port ? Number(url.port) : 80 };
  } catch {
    return null;
  }
}

export function isAllowedStudioHost(value, port) {
  const parsed = parseHostHeader(value);
  if (!parsed || parsed.port !== Number(port)) return false;
  return parsed.hostname === 'localhost'
    || parsed.hostname.endsWith('.local')
    || isPrivateLanAddress(parsed.hostname);
}

export function assertStudioRequestNetwork(request, options) {
  const remoteAddress = normalizeRemoteAddress(request.socket?.remoteAddress);
  if (!isPrivateLanAddress(remoteAddress)) throw Object.assign(new Error('Harness Studio only accepts this Mac and the local network'), { statusCode: 403 });
  if (!isAllowedStudioHost(request.headers.host, options.port)) throw Object.assign(new Error('invalid Harness Studio host'), { statusCode: 403 });
  return remoteAddress;
}

export function assertStudioWriteOrigin(request, options) {
  const origin = String(request.headers.origin ?? '');
  if (!origin) throw Object.assign(new Error('browser origin is required for writes'), { statusCode: 403 });
  let parsed;
  try { parsed = new URL(origin); } catch { throw Object.assign(new Error('invalid browser origin'), { statusCode: 403 }); }
  const expectedProtocol = options.https ? 'https:' : 'http:';
  if (parsed.protocol !== expectedProtocol || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !isAllowedStudioHost(parsed.host, options.port)
    || parsed.host.toLowerCase() !== String(request.headers.host ?? '').toLowerCase()) {
    throw Object.assign(new Error('cross-origin write refused'), { statusCode: 403 });
  }
}

export function studioLanUrls(port, options = {}) {
  const protocol = options.https ? 'https' : 'http';
  const interfaces = options.interfaces ?? networkInterfaces();
  const urls = new Set();
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (record.internal || record.family !== 'IPv4' || !isPrivateLanAddress(record.address)) continue;
      urls.add(`${protocol}://${record.address}:${port}`);
    }
  }
  return [...urls].sort();
}
