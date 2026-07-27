/**
 * Outbound SMTP identity configuration shared by setup preflight and MTA boot.
 *
 * Environment JSON is operator input. Canonicalize address keys before
 * deduplication so equivalent IPv6 spellings cannot silently select different
 * EHLO identities in the wizard and runtime.
 */

import { parseIpAddress } from './ipAddress';

export function assertValidOutboundEhloHostname(value: string, source: string): void {
	const trimmed = value.trim();
	if (trimmed.length === 0 || /\s/.test(value)) {
		throw new Error(
			`${source} must be a hostname with no whitespace, got: ${JSON.stringify(value)}`
		);
	}
	if (trimmed.toLowerCase() === 'localhost') {
		throw new Error(`${source} must be a public FQDN, not 'localhost'`);
	}
	if (parseIpAddress(trimmed) || /^[0-9.]+$/.test(trimmed) || trimmed.includes(':')) {
		throw new Error(
			`${source} must be a hostname, not an IP address, got: ${JSON.stringify(value)}`
		);
	}
	if (trimmed.length > 253 || !trimmed.includes('.')) {
		throw new Error(
			`${source} must be a fully qualified domain name with a dot, got: ${JSON.stringify(value)}`
		);
	}
	if (!trimmed.split('.').every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label))) {
		throw new Error(`${source} is not a valid FQDN, got: ${JSON.stringify(value)}`);
	}
}

export function parseCanonicalEhloHostnames(raw: string | undefined): Record<string, string> {
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
		assertValidOutboundEhloHostname(name, `EHLO_HOSTNAMES[${rawIp}]`);
		const existing = hostnames[ip];
		if (existing && existing.toLowerCase() !== name.toLowerCase()) {
			throw new Error(`EHLO_HOSTNAMES contains conflicting names for canonical address ${ip}`);
		}
		hostnames[ip] ??= name;
	}
	return hostnames;
}

function parseCanonicalPoolList(raw: string | undefined, source: string): string[] {
	if (raw === undefined) return [];
	const addresses: string[] = [];
	for (const entry of raw.split(',')) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const parsed = parseIpAddress(trimmed);
		if (!parsed) throw new Error(`${source} contains an invalid bare IP address: ${trimmed}`);
		if (!addresses.includes(parsed.address)) addresses.push(parsed.address);
	}
	return addresses;
}

/**
 * Project the MTA process's canonical compose variables into the aliases read by
 * Convex functions. Canonical values win when present; legacy alias-only
 * installations remain unchanged.
 */
export function projectCanonicalMtaRuntimeEnv(env: Record<string, string>): Record<string, string> {
	const projected = { ...env };
	if (env['IP_POOLS_TRANSACTIONAL'] !== undefined || env['IP_POOLS_CAMPAIGN'] !== undefined) {
		const transactional = parseCanonicalPoolList(
			env['IP_POOLS_TRANSACTIONAL'],
			'IP_POOLS_TRANSACTIONAL'
		);
		const campaign = parseCanonicalPoolList(env['IP_POOLS_CAMPAIGN'], 'IP_POOLS_CAMPAIGN');
		projected['MTA_IP_POOLS'] = [
			...transactional,
			...campaign.filter((ip) => !transactional.includes(ip)),
		].join(',');
	}
	if (env['RETURN_PATH_DOMAIN'] !== undefined) {
		projected['MTA_RETURN_PATH_DOMAIN'] = env['RETURN_PATH_DOMAIN'].trim();
	}
	// The VERP signing key is ONE secret with two readers: the MTA verifies the
	// tokens it minted, and Convex mints the same tokens on relay sends. Project
	// it rather than making an operator hand-copy a signing key into a second
	// variable — a silent typo there mints tokens the MTA will never verify.
	if (env['BOUNCE_VERP_KEY'] !== undefined) {
		projected['MTA_BOUNCE_VERP_KEY'] = env['BOUNCE_VERP_KEY'].trim();
	}
	return projected;
}
