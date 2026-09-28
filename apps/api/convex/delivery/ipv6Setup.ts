'use node';

/**
 * Deliverability Center → "Set up IPv6": check a candidate IPv6 sending address
 * before the operator switches outbound IPv6 on. See `./ipv6SetupCheck.ts`.
 *
 * Nothing here writes configuration. The MTA reads its pools from the server's
 * `.env` at boot, so the result carries the env lines for the operator to apply.
 */

import dns from 'node:dns/promises';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { checkIpv6SendingAddress, type Ipv6SetupResult } from './ipv6SetupCheck';

// authz: owner/admin gate is enforced by the inherited-identity
// `checklist.getAdminScope` query before any lookup runs.
export const checkAddress = authedAction({
	args: { address: v.string() },
	handler: async (ctx, args): Promise<Ipv6SetupResult> => {
		const { organizationId } = (await ctx.runQuery(
			internal.delivery.checklist.getAdminScope,
			{}
		)) as { organizationId: string };
		const { warming } = await ctx.runQuery(internal.delivery.checklist.getVerificationContext, {
			organizationId,
			itemId: 'deployment.ipv6_address',
		});
		// The default EHLO name is what a new address announces unless an
		// EHLO_HOSTNAMES override names it; the MTA's own report is the fallback.
		const reportedEhlo = warming?.ips.find((entry) => entry.fcrdns)?.fcrdns?.ehlo;
		return checkIpv6SendingAddress(
			{
				address: args.address.slice(0, 64),
				ehloHostname: getOptional('EHLO_HOSTNAME') ?? reportedEhlo,
				returnPathDomain: getOptional('MTA_RETURN_PATH_DOMAIN'),
				pools: warming?.pools ?? null,
			},
			{
				reverse: (ip) => dns.reverse(ip),
				resolve6: (hostname) => dns.resolve6(hostname),
				resolveTxt: (hostname) => dns.resolveTxt(hostname),
				now: () => Date.now(),
			}
		);
	},
});
