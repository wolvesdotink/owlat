/**
 * Send route strategy (module) — shared types.
 *
 * Per ADR-0020. Each strategy module owns one provider-selection algorithm
 * against an org's `providerRoutes` row. The thin `resolveRoute` dispatcher
 * (`../routing.ts`) looks up the strategy via `strategyFor(kind)` and calls
 * `select()`.
 */

import type { ActionableDeliverabilitySignalSource } from '@owlat/shared/deliverabilityRouting';
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
	/**
	 * Why the deliverability fallback engaged. Derived from the SHARED signal
	 * taxonomy rather than re-spelled here, so an added advisory source (which
	 * must never surface as a routing verdict) cannot silently become a legal
	 * reason: `route.ts`'s actionable filter is load-bearing by construction.
	 * `warmup_overflow` is not a signal at all — it is the resolver's own reason.
	 */
	deliverabilityReason?: ActionableDeliverabilitySignalSource | 'warmup_overflow';
}

export interface SendRouteStrategyModule<K extends SendRouteStrategyKind> {
	readonly kind: K;

	/**
	 * Whether `select()` is a function of its inputs alone. False for
	 * `workload_split`, which draws at random on every call, so two calls with
	 * identical inputs can return different providers.
	 *
	 * Load-bearing for BATCH callers that record which transport a recipient
	 * was assigned to (`delivery/sendAssignments.ts`): they resolve once per
	 * cell, while the worker draws again independently per recipient at
	 * dispatch. Under a non-deterministic strategy a recorded arm would be
	 * wrong for roughly half the batch, so those callers must record no row
	 * at all — a guessed arm is worse than a missing row.
	 */
	readonly isDeterministic: boolean;

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
