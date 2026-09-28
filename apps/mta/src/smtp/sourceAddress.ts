/**
 * Which local address an outbound SMTP socket binds for a configured sending IP.
 *
 * On a host-networked MTA every pool IP is assigned to an interface, and binding
 * it is what makes each pool send from its own address. The shipped Docker
 * deployment runs the MTA on a bridge network instead: the container only owns
 * a private bridge address, the host's public IP is not assignable inside it,
 * and binding it fails with EADDRNOTAVAIL on every connection. Traffic still
 * leaves from that public IP — Docker masquerades the bridge address to the
 * host's — so in that topology the right move is to not bind at all.
 *
 * The fallback is deliberately narrow so a typo'd or not-yet-assigned IP on a
 * host-networked box keeps failing loudly (source-address readiness relies on
 * that): it applies only to IPv4, only when the configured IP is globally
 * routable, and only when the container has no globally routable IPv4 address,
 * i.e. every outbound packet is NATed anyway. IPv6 always binds explicitly so
 * the OS never picks an IPv6 source whose PTR/SPF readiness was never checked.
 */

import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

type Interfaces = ReturnType<typeof networkInterfaces>;

/** IANA special-purpose ranges that are never a host's public egress address. */
const NON_GLOBAL = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 3],
] as const) {
	NON_GLOBAL.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 127],
	['fc00::', 7],
	['fe80::', 10],
	['2001:db8::', 32],
	['ff00::', 8],
] as const) {
	NON_GLOBAL.addSubnet(network, prefix, 'ipv6');
}

function familyOf(ip: string): 'ipv4' | 'ipv6' | null {
	const version = isIP(ip);
	return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

/** Whether `ip` is a globally routable unicast address. */
export function isGlobalAddress(ip: string): boolean {
	const family = familyOf(ip);
	return family !== null && !NON_GLOBAL.check(ip, family);
}

/**
 * The address to bind for `ip`, or `undefined` to let the kernel pick the
 * source (behind NAT, see the module comment). Pure over `interfaces`.
 */
export function resolveSourceAddress(
	ip: string,
	interfaces: Interfaces = networkInterfaces()
): string | undefined {
	if (familyOf(ip) !== 'ipv4' || !isGlobalAddress(ip)) return ip;
	const local = Object.values(interfaces)
		.flat()
		.filter((entry) => entry !== undefined && familyOf(entry.address) === 'ipv4')
		.map((entry) => entry!.address);
	if (local.includes(ip)) return ip;
	return local.some(isGlobalAddress) ? ip : undefined;
}
