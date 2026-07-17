/**
 * EHLO hostname validation and per-IP resolution.
 *
 * Split out of `config.ts` to keep that module under the file-size gate and to
 * co-locate the EHLO-specific concerns: the FCrDNS-oriented FQDN validator run at
 * boot and the per-bind-IP name resolver a multi-IP send path consults. Both are
 * re-exported from `config.ts` so existing importers are unaffected.
 */

import type { MtaConfig } from './config.js';

/**
 * Validate that a string is a publicly-routable, multi-label FQDN suitable for
 * EHLO. RFC 5321 §4.1.1.1 requires the EHLO argument to be the client's fully
 * qualified domain name, and RFC 1912 §2.1 / the 2024 Gmail+Yahoo bulk-sender
 * rules require it to match the IP's PTR record. A bare hostname ('mta1'),
 * 'localhost', a raw IP literal ('203.0.113.10'), or anything with whitespace
 * can never satisfy FCrDNS, so we reject them at startup instead of silently
 * shipping mail that fails authentication.
 */
export function assertValidEhloHostname(value: string, source: string): void {
	const trimmed = value.trim();

	if (trimmed.length === 0 || /\s/.test(value)) {
		throw new Error(
			`${source} must be a hostname with no whitespace, got: ${JSON.stringify(value)}`
		);
	}
	if (trimmed === 'localhost') {
		throw new Error(`${source} must be a public FQDN, not 'localhost'`);
	}
	// Reject IPv4/IPv6 literals — EHLO must be a name, not an address.
	if (/^[0-9.]+$/.test(trimmed) || trimmed.includes(':')) {
		throw new Error(
			`${source} must be a hostname, not an IP address, got: ${JSON.stringify(value)}`
		);
	}
	// Require at least two labels (a dot) — bare hostnames like 'mta1' are not FQDNs.
	if (!trimmed.includes('.')) {
		throw new Error(
			`${source} must be a fully qualified domain name with a dot, got: ${JSON.stringify(value)}`
		);
	}
	// Each label: alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphen.
	const labelOk = trimmed
		.split('.')
		.every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
	if (!labelOk) {
		throw new Error(`${source} is not a valid FQDN, got: ${JSON.stringify(value)}`);
	}
}

/**
 * Resolve the EHLO hostname to announce when sending from a given bind IP.
 *
 * Returns the per-IP override from `config.ehloHostnames` when one exists for
 * the bind IP, otherwise the global `config.ehloHostname`. This is what lets a
 * multi-IP deployment present each IP's own PTR-matching name so every IP — not
 * just one — can pass FCrDNS.
 */
export function resolveEhloForIp(
	config: Pick<MtaConfig, 'ehloHostname' | 'ehloHostnames'>,
	bindIp: string
): string {
	return config.ehloHostnames[bindIp] ?? config.ehloHostname;
}
