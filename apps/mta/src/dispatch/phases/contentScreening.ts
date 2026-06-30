/**
 * Phase: content pre-screening.
 *
 * Drops the attempt (no retry) if the content fails screening.
 * No-op when `config.contentScreeningEnabled` is false.
 */

import { screenContent } from '../../intelligence/contentScreening.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const contentScreeningPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'content_screening',
	async run(deps, ctx) {
		if (!deps.config.contentScreeningEnabled) {
			return { kind: 'continue', ctx };
		}

		const screening = await screenContent(deps.redis, ctx.job, deps.config);
		if (!screening.allowed) {
			return {
				kind: 'drop',
				status: 'screened',
				reason: screening.reason ?? 'content_screened',
			};
		}
		return { kind: 'continue', ctx };
	},
};
