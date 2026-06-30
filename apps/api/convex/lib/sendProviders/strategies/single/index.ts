/**
 * `single` send route strategy.
 *
 * Per ADR-0020. Use the first enabled provider unconditionally; ignore
 * health. The simplest strategy — equivalent to "no routing, just pick this
 * one."
 */

import type { SendRouteStrategyModule } from '../types';

export const singleStrategy: SendRouteStrategyModule<'single'> = {
	kind: 'single',
	select(entries, ipPool) {
		const first = entries[0];
		if (!first) return null;
		return { providerType: first.providerType, ipPool, source: 'org_config' };
	},
};
