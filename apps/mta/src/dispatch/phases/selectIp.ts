/**
 * Phase: select sending IP.
 *
 * Picks an active (non-DNSBL-blocked) IP from the resolved pool via
 * round-robin. Defers the attempt (60s) when no IPs are available.
 */

import { selectIpWithLease } from '../../scaling/ipPool.js';
import type { Phase } from '../pipeline.js';
import type { CtxWithIp, CtxWithPool } from '../types.js';

export const selectIpPhase: Phase<CtxWithPool, CtxWithIp> = {
	name: 'select_ip',
	async run(deps, ctx) {
		const reserved = ctx.job.routingLease;
		if (reserved?.ip && reserved.eligibilityGeneration !== undefined) {
			return {
				kind: 'continue',
				ctx: {
					...ctx,
					ip: reserved.ip,
					eligibilityGeneration: reserved.eligibilityGeneration,
				},
			};
		}
		const lease = await selectIpWithLease(
			deps.redis,
			ctx.pool,
			deps.config.ipPools,
			ctx.dedicatedIp
		);
		if (!lease) {
			return {
				kind: 'defer',
				delayMs: 60_000,
				reason: 'No IPs available for sending',
			};
		}
		return {
			kind: 'continue',
			ctx: { ...ctx, ...lease },
		};
	},
};
