/**
 * Phase: resolve pool routing rules.
 *
 * Enriches the ctx with the resolved pool + optional dedicated IP. Always
 * continues — the helper falls back to the requested pool when no rules
 * match.
 */

import * as poolRules from '../../scaling/poolRules.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx, CtxWithPool } from '../types.js';

export const resolvePoolPhase: Phase<BasePhaseCtx, CtxWithPool> = {
	name: 'resolve_pool',
	async run(deps, ctx) {
		const poolResult = await poolRules.resolvePool(
			deps.redis,
			ctx.job.organizationId,
			ctx.job.ipPool,
			ctx.fromDomain,
			ctx.domain,
		);
		return {
			kind: 'continue',
			ctx: {
				...ctx,
				pool: poolResult.pool,
				dedicatedIp: poolResult.dedicatedIp,
			},
		};
	},
};
