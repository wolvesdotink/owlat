/**
 * Phase: select sending IP.
 *
 * Picks an active (non-DNSBL-blocked) IP from the resolved pool via
 * round-robin, preferring a family the destination's MX hosts have an address
 * in. Defers the attempt (60s) when no IPs are available.
 */

import { selectIpWithLease } from '../../scaling/ipPool.js';
import { reachableFamiliesOf } from '../../smtp/mxAddresses.js';
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
			ctx.dedicatedIp,
			reachableFamiliesOf(ctx.destination.mx, {
				allowPrivate: deps.config.allowPrivateMxTargets === true,
			})
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
