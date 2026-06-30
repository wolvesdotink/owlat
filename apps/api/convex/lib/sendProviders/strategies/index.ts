/**
 * Send route strategy (module) — registry + dispatch.
 *
 * Per ADR-0020. Mirrors `convex/lib/sendProviders/index.ts` shape at a
 * different dispatch unit. Adding a fourth strategy (e.g. `least_loaded`,
 * `geo_aware`) is a one-folder change.
 */

import { singleStrategy } from './single';
import { priorityFailoverStrategy } from './priority_failover';
import { workloadSplitStrategy } from './workload_split';
import type {
	SendRouteStrategyKind,
	SendRouteStrategyModule,
} from './types';

export type {
	SendRouteStrategyKind,
	SendRouteStrategyModule,
	ProviderEntry,
	ProviderHealthStatus,
	ResolvedRoute,
} from './types';

export const SEND_ROUTE_STRATEGIES = {
	single: singleStrategy,
	priority_failover: priorityFailoverStrategy,
	workload_split: workloadSplitStrategy,
} as const;

// Compile-time guard: each registry value must satisfy the module shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`.
const _typecheck: { [K in SendRouteStrategyKind]: SendRouteStrategyModule<K> } =
	SEND_ROUTE_STRATEGIES;
void _typecheck;

export function strategyFor<K extends SendRouteStrategyKind>(
	kind: K,
): SendRouteStrategyModule<K> {
	const mod = SEND_ROUTE_STRATEGIES[kind];
	if (!mod) {
		throw new Error(`Unknown send route strategy: ${kind}`);
	}
	return mod as unknown as SendRouteStrategyModule<K>;
}

export function isSendRouteStrategyKind(
	kind: string | undefined | null,
): kind is SendRouteStrategyKind {
	return (
		kind === 'single' ||
		kind === 'priority_failover' ||
		kind === 'workload_split'
	);
}
