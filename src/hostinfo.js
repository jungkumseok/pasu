import net from 'node:net';
import os from 'node:os';
import { config } from './config.js';

// Where this Pasu runs, for telling servers apart in emails.

/** The ID used when none is set: the public URL's domain, else the machine's hostname. */
export const defaultInstanceId = () => config.publicUrl?.hostname || os.hostname();

const PRIVATE_V4 = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], // private, CGNAT
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8],
];
const v4 = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return !PRIVATE_V4.some(([base, bits]) => Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));
  if (net.isIPv6(ip)) return /^[23]/.test(ip); // global unicast is 2000::/3
  return false;
}

/** Public addresses assigned directly to this machine's interfaces (typical on a VPS), IPv4 first. */
export function interfaceAddresses(interfaces = os.networkInterfaces()) {
  const found = Object.values(interfaces).flat().filter((a) => a && !a.internal && isPublicAddress(a.address));
  return [...new Set(found.sort((a, b) => (a.family === b.family ? 0 : a.family === 'IPv4' ? -1 : 1)).map((a) => a.address))];
}

/**
 * The public IP (or IPs) of this machine, or null when none is visible on its interfaces,
 * as behind NAT. Pasu never asks an outside service; the Pasu ID is what identifies it.
 */
export const publicIp = () => interfaceAddresses().join(', ') || null;
