/**
 * `priority_failover` send route strategy.
 *
 * Per ADR-0020. Walks enabled providers in order; picks the first that is
 * not currently `down` per the health snapshot. Falls back to the first
 * enabled provider if all are down (or no health data is available).
 */

import type { SendRouteStrategyModule } from '../types';

export const priorityFailoverStrategy: SendRouteStrategyModule<'priority_failover'> = {
	kind: 'priority_failover',
	select(entries, ipPool, healthStatuses) {
		if (healthStatuses && healthStatuses.length > 0) {
			for (const entry of entries) {
				const health = healthStatuses.find(
					(h) => h.providerType === entry.providerType,
				);
				if (!health || health.status !== 'down') {
					return { providerType: entry.providerType, ipPool, source: 'org_config' };
				}
			}
		}

		const first = entries[0];
		if (!first) return null;
		return { providerType: first.providerType, ipPool, source: 'org_config' };
	},
};
