/**
 * The SPF `ptr` mechanism (RFC 7208 §5.5).
 *
 * Deprecated for publishers, but receivers MUST still evaluate it: large
 * providers authorize outbound servers that none of their `ip4`/`include`
 * terms cover through `ptr:<their domain>` alone, so skipping it turns their
 * mail into a hard `-all` fail.
 */

import { reverseIpAddressForDns } from '@owlat/shared/ipAddress';
import type { SpfDnsResolver } from './spf.js';
import { addressMatchesSender, senderAddressType } from './spfMechanism.js';

/**
 * RFC 7208 §4.6.4: one `ptr` evaluation may look up the addresses of at most
 * ten PTR names; the names after the first ten are ignored.
 */
const MAX_PTR_NAMES = 10;

function normalizeName(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Whether `senderIp` has a forward-confirmed PTR name equal to `targetDomain`
 * or below it.
 *
 * The PTR query itself is the mechanism's one budgeted lookup, which the caller
 * charges. DNS errors never surface: a failed PTR lookup is no match, and a
 * failed address lookup skips that name (§5.5).
 */
export async function ptrMatches(
	senderIp: string,
	targetDomain: string,
	resolver: SpfDnsResolver
): Promise<boolean> {
	const reversed = reverseIpAddressForDns(senderIp);
	if (!reversed) return false;
	const zone = senderIp.includes(':') ? 'ip6.arpa' : 'in-addr.arpa';
	const target = normalizeName(targetDomain);

	let ptrNames: unknown[];
	try {
		ptrNames = await resolver(`${reversed}.${zone}`, 'PTR');
	} catch {
		return false;
	}

	// Only a name in the target domain can make the mechanism match, so the
	// others are dropped before their forward lookups. The ten-name cap counts
	// the PTR answer as returned, as the RFC states it.
	const candidates = ptrNames
		.slice(0, MAX_PTR_NAMES)
		.filter((name): name is string => typeof name === 'string')
		.map(normalizeName)
		.filter((name) => name === target || name.endsWith(`.${target}`));

	const addressType = senderAddressType(senderIp);
	for (const name of candidates) {
		let addresses: unknown[];
		try {
			addresses = await resolver(name, addressType);
		} catch {
			continue;
		}
		if (
			addresses.some(
				(address) => typeof address === 'string' && addressMatchesSender(senderIp, address)
			)
		) {
			return true;
		}
	}
	return false;
}
