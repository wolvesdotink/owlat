/**
 * Address-family and DNS-result helpers for SPF mechanisms.
 *
 * Kept beside `spf.ts` so its evaluator stays below the repository file-size
 * boundary while the low-level helpers remain independently testable through
 * the public SPF behavior.
 */

import { ipMatchesCidr, ipv6MatchesCidr } from './ip.js';

/** Address-family DNS RR used by SPF's `a` and `mx` mechanisms. */
export function senderAddressType(senderIp: string): 'A' | 'AAAA' {
	return senderIp.includes(':') ? 'AAAA' : 'A';
}

/** Compare a DNS address to the sender without depending on IPv6 text compression. */
export function addressMatchesSender(senderIp: string, address: string): boolean {
	return senderIp.includes(':')
		? ipv6MatchesCidr(senderIp, address)
		: ipMatchesCidr(senderIp, address);
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
