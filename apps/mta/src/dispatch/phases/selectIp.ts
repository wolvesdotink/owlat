/**
 * Phase: select sending IP.
 *
 * Picks an active (non-DNSBL-blocked) IP from the resolved pool via
 * round-robin. Defers the attempt (60s) when no IPs are available.
 */

import { selectIp } from '../../scaling/ipPool.js';
import type { Phase } from '../pipeline.js';
import type { CtxWithIp, CtxWithPool } from '../types.js';

export const selectIpPhase: Phase<CtxWithPool, CtxWithIp> = {
	name: 'select_ip',
	async run(deps, ctx) {
		const ip = await selectIp(deps.redis, ctx.pool, deps.config.ipPools, ctx.dedicatedIp);
		if (!ip) {
			return {
				kind: 'defer',
				delayMs: 60_000,
				reason: 'No IPs available for sending',
			};
		}
		return {
			kind: 'continue',
			ctx: { ...ctx, ip },
		};
	},
};
