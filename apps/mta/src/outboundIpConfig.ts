/** Parse and canonicalize the outbound source-address configuration. */

import {
	isIpv4MappedIpv6,
	parseIpAddress,
	parseIpv6Enabled,
	type IpAddressFamily,
} from '@owlat/shared/ipAddress';
import type { IpPoolConfig } from './types.js';
import { assertValidEhloHostname } from './ehloConfig.js';

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

function parseEhloHostnames(raw: string | undefined): Record<string, string> {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			'EHLO_HOSTNAMES must be valid JSON: {"1.2.3.4":"mail1.example.com","2001:db8::1":"mail6.example.com"}'
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('EHLO_HOSTNAMES must be a JSON object mapping IP to hostname');
	}
	const hostnames: Record<string, string> = {};
	for (const [rawIp, rawName] of Object.entries(parsed as Record<string, unknown>)) {
		const ip = parseIpAddress(rawIp)?.address;
		if (!ip) throw new Error(`EHLO_HOSTNAMES key ${rawIp} is not a valid bare IP address`);
		if (typeof rawName !== 'string') {
			throw new Error(`EHLO_HOSTNAMES value for ${rawIp} must be a string`);
		}
		const name = rawName.trim();
		assertValidEhloHostname(name, `EHLO_HOSTNAMES[${rawIp}]`);
		const existing = hostnames[ip];
		if (existing && existing !== name) {
			throw new Error(`EHLO_HOSTNAMES contains conflicting names for canonical address ${ip}`);
		}
		hostnames[ip] = name;
	}
	return hostnames;
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
	const families = new Set<IpAddressFamily>(
		[...transactional, ...campaign].flatMap((ip) => {
			const parsed = parseIpAddress(ip);
			return parsed ? [parsed.family] : [];
		})
	);
	if (families.has('ipv6') && !families.has('ipv4')) {
		throw new Error(
			'Outbound IPv6 requires at least one configured IPv4 address as a safe fallback'
		);
	}
	return {
		ipPools: { transactional, campaign },
		ehloHostnames: parseEhloHostnames(env['EHLO_HOSTNAMES']),
		ipv6Enabled,
	};
}
