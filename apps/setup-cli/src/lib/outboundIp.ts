/**
 * Pick the address the built-in MTA should send from.
 *
 * `IP_POOLS_TRANSACTIONAL` / `IP_POOLS_CAMPAIGN` are BIND addresses: the MTA
 * opens every outbound SMTP connection from them and verifies their PTR against
 * EHLO_HOSTNAME before it lets a single message leave. docker-compose.yml
 * defaults both to 127.0.0.1, which can never pass that identity check, so a
 * direct-delivery install has to name the box's routable IPv4 explicitly. The
 * installer runs on the box (host networking on the blessed VPS path), so the
 * host's own interfaces are visible and the primary non-loopback IPv4 is the
 * right default; an operator who set the keys by hand is never overridden.
 */

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

/**
 * Choose the primary IPv4 from an interface listing. Pure — tests feed it a
 * fixture. Returns undefined when nothing usable is present so the caller can
 * leave the compose default alone and let the MTA's own identity check report.
 */
export function pickPrimaryIpv4(interfaces: InterfaceAddress[]): string | undefined {
	return interfaces.find(isCandidate)?.address;
}

export function detectPrimaryIpv4(): string | undefined {
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
	return pickPrimaryIpv4(listing);
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
