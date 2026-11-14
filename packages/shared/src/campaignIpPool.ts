/**
 * Which outbound IPs campaign mail leaves from.
 *
 * Campaign mail uses the active IPs of the campaign pool. When none of them is
 * active it borrows the active IPs of the transactional pool, so bulk mail is
 * never parked behind addresses an install has not made ready. Transactional
 * mail never borrows campaign IPs, so it never inherits a bulk IP's reputation.
 *
 * The MTA's IP selection (`apps/mta/src/scaling/ipPool.ts`) sends by this rule,
 * and the API's warming-capacity projection measures by it, so a campaign's
 * pre-flight is judged against the IPs that will really carry it.
 */
export function campaignSendingIps<T>(
	pools: { readonly campaign: readonly T[]; readonly transactional: readonly T[] },
	isActive: (ip: T) => boolean
): { ips: T[]; isBorrowed: boolean } {
	const own = pools.campaign.filter(isActive);
	if (own.length > 0) return { ips: own, isBorrowed: false };
	return { ips: pools.transactional.filter(isActive), isBorrowed: true };
}
