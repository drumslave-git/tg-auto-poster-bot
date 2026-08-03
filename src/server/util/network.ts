import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Ranges that are not on the public internet, so not ours to fetch on behalf
 * of whoever sent a link. 169.254/16 is the one that matters most: it holds the
 * cloud metadata service, and credentials with it.
 */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this host"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. the broadcast address
];

function toInt(ip: string): number {
  return ip.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = toInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (toInt(base) & mask) >>> 0;
  });
}

function isPrivateV6(ip: string): boolean {
  // Zone ids (`fe80::1%eth0`) are not part of the address.
  const address = (ip.toLowerCase().split('%')[0] ?? '').replace(/^\[|]$/g, '');
  if (address === '::' || address === '::1') return true;

  // IPv4-mapped and NAT64 forms embed a v4 address; judge that instead.
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (embedded?.[1] && net.isIPv4(embedded[1])) return isPrivateV4(embedded[1]);

  // fc00::/7 unique-local, fe80::/10 link-local.
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

/** True for loopback, private, link-local and other non-routable addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  // An address we cannot classify is not one we should fetch from.
  return true;
}

/**
 * Why this URL must not be fetched, or null when it is fine.
 *
 * A link is untrusted input as far as the host is concerned: without this,
 * yt-dlp would happily fetch the dashboard's own API, the container's metadata
 * service, or any box on the LAN, and hand the response back as a post.
 *
 * This is a guard, not a boundary. It cannot see a redirect to a private
 * address, nor a DNS record that changes between this check and the fetch. Run
 * the bot with restricted egress if you need a real boundary.
 */
export async function privateHostReason(url: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'That does not look like a URL.';
  }
  if (!host) return 'That URL has no host.';

  // WHATWG keeps IPv6 hosts in brackets; the resolver wants them without.
  const hostname = host.replace(/^\[|]$/g, '');

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return `Could not resolve ${hostname}.`;
  }

  // Any private answer disqualifies the host — a name that resolves to both a
  // public and a private address must not be a way in.
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    return `${hostname} is on a private or local network, which the bot will not fetch from.`;
  }

  return null;
}
