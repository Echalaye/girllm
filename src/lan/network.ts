/**
 * "Private network only" (step 8): the phone listener answers only clients
 * whose address is on a private network, and the pairing QR code lists only
 * this PC's private addresses. Nothing is ever exposed beyond your network.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';

/** IPv4 ranges of private networks (RFC 1918), link-local and loopback. */
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.168.0.0'), 16],
  [ipv4ToInt('169.254.0.0'), 16],
  [ipv4ToInt('127.0.0.0'), 8],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, [base, bits]: [number, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (base & mask);
}

/**
 * Is this address on a private network? IPv4 private / link-local /
 * loopback, IPv6 loopback, unique-local (fc00::/7) and link-local
 * (fe80::/10), and IPv4-mapped IPv6 of those. Anything else (public
 * addresses, CGNAT 100.64/10 used by VPN overlays) is refused.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  let ip = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (isIPv4(ip)) return PRIVATE_V4.some((range) => inRange(ip, range));
  if (isIPv6(ip)) {
    const scopeless = ip.split('%')[0]!;
    if (scopeless === '::1') return true;
    const first = Number.parseInt(scopeless.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * This PC's IPv4 addresses on private networks (what the phone can reach),
 * most likely first: 192.168.x (home Wi-Fi), then 10.x, then 172.16–31.x.
 * Loopback and link-local are left out (useless to a phone).
 */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  const found = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .filter((ip) => isPrivateAddress(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b));
}
