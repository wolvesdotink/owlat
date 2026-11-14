/**
 * Pick the address the built-in MTA should send from.
 *
 * `IP_POOLS_TRANSACTIONAL` / `IP_POOLS_CAMPAIGN` are BIND addresses: the MTA
 * opens every outbound SMTP connection from them and verifies their PTR against
 * EHLO_HOSTNAME before it lets a single message leave. docker-compose.yml
 * defaults both to 127.0.0.1, which can never pass that identity check, so a
 * direct-delivery install has to name the box's routable IPv4 explicitly. The
 * installer runs on the box (host networking on the blessed VPS path), so the
 * host's own routing table is visible; an operator who set the keys by hand is
 * never overridden.
 *
 * The default is the source address of the default route, not the first
 * address an interface lists. Behind the Docker bridge the MTA cannot bind its
 * IP, so NAT sends from exactly that route source; on a host with a second or
 * floating IPv4 the first listed address can be another one, and every PTR,
 * SPF and blocklist check would then be run for an address that never sends.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { EnvMap } from './env';

export interface InterfaceAddress {
	name: string;
	address: string;
	family: string | number;
	internal: boolean;
}

/** Container/bridge/tunnel interfaces that carry no public identity. */
const IGNORED_INTERFACE_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'tun', 'tap', 'wg', 'lo'];

function isCandidate(iface: InterfaceAddress): boolean {
	if (iface.internal) return false;
	if (iface.family !== 'IPv4' && iface.family !== 4) return false;
	if (IGNORED_INTERFACE_PREFIXES.some((prefix) => iface.name.startsWith(prefix))) return false;
	// Link-local (169.254/16) means DHCP never handed out an address.
	if (iface.address.startsWith('169.254.')) return false;
	return true;
}

export interface OutboundIpChoice {
	ip: string;
	interfaceName: string;
	/** `default-route`: the kernel's source for public destinations; `interface`: no route answer. */
	source: 'default-route' | 'interface';
	/** The other usable IPv4 addresses on this host, which the operator may want instead. */
	others: string[];
}

/**
 * Choose the sending IPv4 from an interface listing and the default route's
 * source address. Pure — tests feed it a fixture. The route source wins when
 * it is a usable address of this host; without one the first usable interface
 * address is the fallback. Returns undefined when nothing usable is present so
 * the caller can leave the compose default alone and let the MTA's own
 * identity check report.
 */
export function chooseOutboundIpv4(
	interfaces: InterfaceAddress[],
	defaultRouteSource?: string
): OutboundIpChoice | undefined {
	const routed = interfaces.find(
		(iface) =>
			iface.address === defaultRouteSource &&
			!iface.internal &&
			(iface.family === 'IPv4' || iface.family === 4) &&
			!iface.address.startsWith('169.254.')
	);
	const chosen = routed ?? interfaces.find(isCandidate);
	if (!chosen) return undefined;
	const others = [
		...new Set(
			interfaces
				.filter((iface) => isCandidate(iface) && iface.address !== chosen.address)
				.map((iface) => iface.address)
		),
	];
	return {
		ip: chosen.address,
		interfaceName: chosen.name,
		source: routed ? 'default-route' : 'interface',
		others,
	};
}

export function pickPrimaryIpv4(
	interfaces: InterfaceAddress[],
	defaultRouteSource?: string
): string | undefined {
	return chooseOutboundIpv4(interfaces, defaultRouteSource)?.ip;
}

/** One line for the installer log: which address, and why that one. */
export function describeOutboundIpChoice(choice: OutboundIpChoice): string {
	const why =
		choice.source === 'default-route'
			? `the source address of this server's default route (${choice.interfaceName}), which is where outbound mail leaves from`
			: `the first address on ${choice.interfaceName}; the default route's source address could not be read`;
	const others =
		choice.others.length > 0
			? `. Other addresses on this server: ${choice.others.join(', ')}; set IP_POOLS_TRANSACTIONAL and IP_POOLS_CAMPAIGN to send from one of them instead, and make it the default route's source`
			: '';
	return `Sending pools default to ${choice.ip}, ${why}${others}`;
}

/**
 * The source address the kernel picks for a public IPv4 destination. A UDP
 * `connect` only runs the route lookup: no packet is sent, and no service is
 * asked. The destination is a documentation address, routed like any other
 * public one, through the default route.
 */
export function detectDefaultRouteIpv4(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = createSocket('udp4');
		const done = (address: string | undefined) => {
			socket.close();
			resolve(address);
		};
		socket.once('error', () => done(undefined));
		socket.connect(9, '192.0.2.1', () => {
			try {
				done(socket.address().address);
			} catch {
				done(undefined);
			}
		});
	});
}

function interfaceListing(): InterfaceAddress[] {
	const listing: InterfaceAddress[] = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			listing.push({
				name,
				address: address.address,
				family: address.family,
				internal: address.internal,
			});
		}
	}
	return listing;
}

export async function detectOutboundIpv4(): Promise<OutboundIpChoice | undefined> {
	return chooseOutboundIpv4(interfaceListing(), await detectDefaultRouteIpv4());
}

/**
 * Fill the two pool keys with `ip` when the operator left both unset. Returns
 * true when the env was changed. A partially set pair is left untouched: that is
 * a deliberate operator configuration, not a missing default.
 */
export function applyOutboundIpDefaults(env: EnvMap, ip: string | undefined): boolean {
	if (!ip) return false;
	const hasTransactional = (env['IP_POOLS_TRANSACTIONAL'] ?? '') !== '';
	const hasCampaign = (env['IP_POOLS_CAMPAIGN'] ?? '') !== '';
	if (hasTransactional || hasCampaign) return false;
	env['IP_POOLS_TRANSACTIONAL'] = ip;
	env['IP_POOLS_CAMPAIGN'] = ip;
	return true;
}
