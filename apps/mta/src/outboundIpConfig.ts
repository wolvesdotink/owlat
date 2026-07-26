/** Parse and canonicalize the outbound source-address configuration. */

import {
	isIpv4MappedIpv6,
	hasIpv4FallbackForIpv6,
	parseIpAddress,
	parseIpv6Enabled,
} from '@owlat/shared/ipAddress';
import { parseCanonicalEhloHostnames } from '@owlat/shared/outboundIdentity';
import type { IpPoolConfig } from './types.js';

export interface OutboundIpConfig {
	ipPools: IpPoolConfig;
	ehloHostnames: Record<string, string>;
	ipv6Enabled: boolean;
}

function parsePool(
	raw: string,
	name: 'IP_POOLS_TRANSACTIONAL' | 'IP_POOLS_CAMPAIGN',
	ipv6Enabled: boolean
): string[] {
	const entries = raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) throw new Error(`${name} must contain at least one IP`);
	const addresses: string[] = [];
	for (const entry of entries) {
		const parsed = parseIpAddress(entry);
		if (!parsed) throw new Error(`${entry} is not a valid bare IP address in IP_POOLS_*`);
		if (parsed.family === 'ipv6') {
			if (!ipv6Enabled) {
				throw new Error(
					`${entry} is IPv6, but MTA_IPV6_ENABLED is false; enable IPv6 explicitly first`
				);
			}
			if (parsed.address === '::') {
				throw new Error('The IPv6 unspecified address :: cannot select an outbound source');
			}
			if (isIpv4MappedIpv6(parsed.address)) {
				throw new Error(`${entry} is IPv4-mapped IPv6, not a native IPv6 source address`);
			}
		}
		if (!addresses.includes(parsed.address)) addresses.push(parsed.address);
	}
	return addresses;
}

export function loadOutboundIpConfig(
	requiredEnv: (key: string) => string,
	env: NodeJS.ProcessEnv = process.env
): OutboundIpConfig {
	const ipv6Enabled = parseIpv6Enabled(env['MTA_IPV6_ENABLED']);
	const transactional = parsePool(
		requiredEnv('IP_POOLS_TRANSACTIONAL'),
		'IP_POOLS_TRANSACTIONAL',
		ipv6Enabled
	);
	const campaign = parsePool(requiredEnv('IP_POOLS_CAMPAIGN'), 'IP_POOLS_CAMPAIGN', ipv6Enabled);
	for (const [name, addresses] of [
		['transactional', transactional],
		['campaign', campaign],
	] as const) {
		if (!hasIpv4FallbackForIpv6(addresses)) {
			throw new Error(
				`Outbound IPv6 in the ${name} pool requires an IPv4 fallback in that same pool`
			);
		}
	}
	return {
		ipPools: { transactional, campaign },
		ehloHostnames: parseCanonicalEhloHostnames(env['EHLO_HOSTNAMES']),
		ipv6Enabled,
	};
}
