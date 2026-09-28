/**
 * Which local address an outbound SMTP socket binds for a configured sending IP.
 *
 * On a host-networked MTA every pool IP is assigned to an interface, and binding
 * it is what makes each pool send from its own address. The shipped Docker
 * deployment runs the MTA on a bridge network instead: the container only owns
 * a private bridge address, the host's public IP is not assignable inside it,
 * and binding it fails with EADDRNOTAVAIL on every connection. In that topology
 * the socket binds nothing and Docker masquerades the bridge address to the
 * host's outbound address, so the right move is to not bind at all.
 *
 * The fallback applies only to IPv4, only when the configured IP is globally
 * routable, and only when the container has no globally routable IPv4 address,
 * i.e. every outbound packet is NATed anyway. IPv6 always binds explicitly so
 * the OS never picks an IPv6 source whose PTR/SPF readiness was never checked.
 *
 * What the fallback gives up: the MTA no longer chooses its source address, the
 * host's NAT does, and nothing inside the container can observe the translated
 * address. A mistyped or not-yet-assigned IP fails loudly (EADDRNOTAVAIL) only
 * when the MTA can see its public address, i.e. with host networking. Behind
 * NAT the same mistake sends from the host's default outbound address while
 * announcing the configured IP's EHLO name, and nothing reports it. Two or more
 * same-family pool IPs behind NAT all leave from that one address;
 * `sharedNatEgressIps` names them so the boot log and the health probe can say
 * so, but delivery continues.
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

/**
 * The pool IPs that NAT collapses onto one egress address: every group of two
 * or more same-family addresses that `sourceAddressFor` leaves unbound. The
 * kernel picks one source for all of them and the NAT rewrites it to the
 * host's outbound address, so per-IP pools, warm-up, reputation and EHLO names
 * are credited to addresses that did not send the mail. Input order, deduped.
 */
export function sharedNatEgressIps(
	ips: readonly string[],
	sourceAddressFor: (ip: string) => string | undefined = (ip) => resolveSourceAddress(ip)
): string[] {
	const unboundByFamily = new Map<string, string[]>();
	for (const ip of new Set(ips)) {
		if (sourceAddressFor(ip) !== undefined) continue;
		const family = familyOf(ip) ?? 'unknown';
		unboundByFamily.set(family, [...(unboundByFamily.get(family) ?? []), ip]);
	}
	const shared = new Set([...unboundByFamily.values()].filter((group) => group.length > 1).flat());
	return [...new Set(ips)].filter((ip) => shared.has(ip));
}

interface SourceAddressLog {
	warn: (details: object, message: string) => void;
	info: (details: object, message: string) => void;
}

/**
 * Say at boot which sending IPs leave through NAT instead of a bound socket.
 * Advisory only: sending is never stopped or blocked here, because an install
 * that delivers through NAT today must keep delivering after an upgrade.
 */
export function logNatSourceAddresses(
	ips: readonly string[],
	log: SourceAddressLog,
	sourceAddressFor: (ip: string) => string | undefined = (ip) => resolveSourceAddress(ip)
): void {
	const shared = sharedNatEgressIps(ips, sourceAddressFor);
	if (shared.length > 0) {
		log.warn(
			{ ips: shared },
			'Sending IPs share one NAT egress address: this MTA has no public IPv4 address of its own ' +
				"(e.g. a Docker bridge network), so it cannot bind them and NAT sends all of them from the host's " +
				'one outbound address. Per-IP pools, warm-up, reputation and EHLO names are credited to ' +
				'addresses that did not send the mail. Delivery continues. Fix: run the MTA with host ' +
				'networking or macvlan so each IP is bound, or configure one sending IP per install.'
		);
	}
	const sharedSet = new Set(shared);
	const unbound = [...new Set(ips)].filter(
		(ip) => !sharedSet.has(ip) && sourceAddressFor(ip) === undefined
	);
	if (unbound.length > 0) {
		log.info(
			{ ips: unbound },
			'Sending IP is not assigned inside this network namespace, so outbound SMTP binds nothing ' +
				"and NAT picks the source address. The MTA cannot see the translated address: make sure the host's " +
				'default outbound IPv4 address is this IP.'
		);
	}
}
