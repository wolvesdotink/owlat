/**
 * `workload_split` send route strategy.
 *
 * Per ADR-0020. Weighted random selection across enabled providers,
 * filtering out any that are currently `down`. Weights default to 100 when
 * unset (uniform distribution). If every enabled provider is `down`, falls
 * back to a weighted pick over the full enabled set so a send still leaves
 * — matches today's behaviour where "all unhealthy" doesn't block.
 */

import type { SendRouteStrategyModule } from '../types';

export const workloadSplitStrategy: SendRouteStrategyModule<'workload_split'> = {
	kind: 'workload_split',
	select(entries, ipPool, healthStatuses) {
		const candidates = healthStatuses
			? entries.filter((p) => {
					const health = healthStatuses.find(
						(s) => s.providerType === p.providerType,
					);
					return !health || health.status !== 'down';
				})
			: entries;

		const pool = candidates.length > 0 ? candidates : entries;
		if (pool.length === 0) return null;

		const totalWeight = pool.reduce((sum, p) => sum + (p.weight ?? 100), 0);
		let random = Math.random() * totalWeight;

		for (const entry of pool) {
			random -= entry.weight ?? 100;
			if (random <= 0) {
				return { providerType: entry.providerType, ipPool, source: 'org_config' };
			}
		}

		// Floating-point edge: fall through to last candidate.
		const last = pool[pool.length - 1]!;
		return { providerType: last.providerType, ipPool, source: 'org_config' };
	},
};
