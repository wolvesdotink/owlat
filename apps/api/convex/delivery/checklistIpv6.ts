/**
 * Outbound IPv6 is an opt-in the MTA refuses to start without
 * (`MTA_IPV6_ENABLED=true` before any IPv6 pool entry), so the pools it reports
 * are the one place the Deliverability Center can read the opt-in from. While
 * it is off, the six IPv6 checks describe a feature nobody asked for: the
 * Center leaves them out of the grade, the counts and "do this next", and the
 * page shows one "IPv6 is off" section with the setup flow instead.
 */

import type { DeliverabilityCheckId } from '@owlat/shared';
import { ipAddressFamily } from '@owlat/shared/ipAddress';
import { checklistTraits } from './checklistTraits';

/** The IPv6 addresses in the MTA's last reported pools, in report order. */
export function ipv6SendingAddresses(
	warming: { ips: ReadonlyArray<{ ip: string }> } | null | undefined
): string[] {
	return (warming?.ips ?? [])
		.map((entry) => entry.ip)
		.filter((ip) => ipAddressFamily(ip) === 'ipv6');
}

export function isIpv6CheckId(itemId: DeliverabilityCheckId): boolean {
	return checklistTraits(itemId).addressFamily === 'ipv6';
}

/**
 * Split materialized items into the ones the Center grades and the IPv6 ones.
 * With IPv6 off, `ipv6` is empty and its checks are dropped entirely.
 */
export function partitionIpv6Items<T extends { id: DeliverabilityCheckId }>(
	items: readonly T[],
	ipv6Enabled: boolean
): { graded: T[]; ipv6: T[] } {
	const ipv6 = items.filter((item) => isIpv6CheckId(item.id));
	const rest = items.filter((item) => !isIpv6CheckId(item.id));
	return ipv6Enabled ? { graded: [...rest, ...ipv6], ipv6 } : { graded: rest, ipv6: [] };
}
