/**
 * Send route strategy (module) — shared types.
 *
 * Per ADR-0020. Each strategy module owns one provider-selection algorithm
 * against an org's `providerRoutes` row. The thin `resolveRoute` dispatcher
 * (`../routing.ts`) looks up the strategy via `strategyFor(kind)` and calls
 * `select()`.
 */

import type { SendProviderKind } from '../types';

export type SendRouteStrategyKind = 'single' | 'priority_failover' | 'workload_split';

export interface ProviderEntry {
	providerType: SendProviderKind;
	weight?: number;
	isEnabled: boolean;
}

export interface ProviderHealthStatus {
	/**
	 * Provider type as stored on the `providerHealth` row — typed as
	 * `string` (not `SendProviderKind`) because the table can hold rows
	 * for retired providers. Strategies compare for equality only.
	 */
	providerType: string;
	status: 'healthy' | 'degraded' | 'down';
	successRate: number;
}

export interface ResolvedRoute {
	providerType: SendProviderKind;
	ipPool?: string;
	warmupOverflowEnabled?: boolean;
	// 'org_config' = chosen by a providerRoutes strategy; 'env_fallback' =
	// derived from EMAIL_PROVIDER. There is no implicit 'default' (MTA) source:
	// when nothing is configured, route resolution returns `null` (unconfigured),
	// never a phantom MTA.
	source: 'org_config' | 'env_fallback' | 'deliverability_fallback';
	deliverabilityReason?:
		| 'ip_quarantined'
		| 'dnsbl_listed'
		| 'breaker_open'
		| 'persistent_defers'
		| 'warmup_overflow';
}

export interface SendRouteStrategyModule<K extends SendRouteStrategyKind> {
	readonly kind: K;

	/**
	 * Pure function. Given enabled providers and (optionally) their
	 * health statuses, return the chosen provider — or null if no
	 * candidate is selectable (caller falls back).
	 */
	select(
		entries: readonly ProviderEntry[],
		ipPool: string | undefined,
		healthStatuses?: readonly ProviderHealthStatus[]
	): ResolvedRoute | null;
}
