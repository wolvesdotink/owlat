/**
 * Address-family and DNS-result helpers for SPF mechanisms.
 *
 * Kept beside `spf.ts` so its evaluator stays below the repository file-size
 * boundary while the low-level helpers remain independently testable through
 * the public SPF behavior.
 */

import { ipMatchesCidr, ipv6MatchesCidr } from './ip.js';

export interface AddressMechanism {
	readonly kind: 'a' | 'mx';
	readonly domainSpec?: string;
	readonly ipv4Cidr?: number;
	readonly ipv6Cidr?: number;
}

/**
 * Parse RFC 7208's `a` / `mx` mechanism grammar, including dual CIDR suffixes
 * (`a/24`, `a//64`, `mx:example/24//64`). `undefined` means another mechanism;
 * `null` means an a/mx-shaped term with invalid grammar or prefix bounds.
 */
export function parseAddressMechanism(mechanism: string): AddressMechanism | null | undefined {
	const lower = mechanism.toLowerCase();
	const kind = lower.startsWith('a') ? 'a' : lower.startsWith('mx') ? 'mx' : undefined;
	if (kind === undefined) return undefined;
	const rest = mechanism.slice(kind.length);
	if (rest !== '' && !rest.startsWith(':') && !rest.startsWith('/')) return undefined;

	const slash = rest.indexOf('/');
	const domainPart = slash === -1 ? rest : rest.slice(0, slash);
	if (domainPart !== '' && (!domainPart.startsWith(':') || domainPart.length === 1)) return null;
	const domainSpec = domainPart.startsWith(':') ? domainPart.slice(1) : undefined;
	if (slash === -1) return { kind, ...(domainSpec !== undefined ? { domainSpec } : {}) };

	const cidrPart = rest.slice(slash);
	const match = cidrPart.match(/^(?:\/(\d+))?(?:\/\/(\d+))?$/);
	if (!match || (match[1] === undefined && match[2] === undefined)) return null;
	const ipv4Cidr = match[1] === undefined ? undefined : Number(match[1]);
	const ipv6Cidr = match[2] === undefined ? undefined : Number(match[2]);
	if (
		(ipv4Cidr !== undefined && (ipv4Cidr > 32 || !Number.isInteger(ipv4Cidr))) ||
		(ipv6Cidr !== undefined && (ipv6Cidr > 128 || !Number.isInteger(ipv6Cidr)))
	) {
		return null;
	}
	return {
		kind,
		...(domainSpec !== undefined ? { domainSpec } : {}),
		...(ipv4Cidr !== undefined ? { ipv4Cidr } : {}),
		...(ipv6Cidr !== undefined ? { ipv6Cidr } : {}),
	};
}

/** Address-family DNS RR used by SPF's `a` and `mx` mechanisms. */
export function senderAddressType(senderIp: string): 'A' | 'AAAA' {
	return senderIp.includes(':') ? 'AAAA' : 'A';
}

/** Compare a DNS address to the sender without depending on IPv6 text compression. */
export function addressMatchesSender(
	senderIp: string,
	address: string,
	prefixLength?: number
): boolean {
	const range = prefixLength === undefined ? address : `${address}/${prefixLength}`;
	return senderIp.includes(':') ? ipv6MatchesCidr(senderIp, range) : ipMatchesCidr(senderIp, range);
}

/** RFC 7208 DNS errors other than NXDOMAIN/NODATA terminate evaluation temporarily. */
export function dnsTemperror(
	mechanism: string,
	target: string,
	err: unknown
): { result: 'temperror'; explanation: string } {
	return {
		result: 'temperror',
		explanation: `SPF ${mechanism} lookup failed for ${target}: ${(err as { code?: string }).code ?? 'error'}`,
	};
}
