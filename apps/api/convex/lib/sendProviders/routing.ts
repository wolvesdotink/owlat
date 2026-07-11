/**
 * Send route resolution — thin dispatcher.
 *
 * Per ADR-0020. Looks up the strategy module by `routeConfig.strategy` and
 * calls its `select()`. Owns the fallback semantics for null configs, empty
 * enabled-provider sets, and the env-var → `'mta'` default chain.
 *
 * The strategy switch lives behind `strategyFor()` — adding a new strategy
 * is a one-folder change in `./strategies/`.
 */

import { getOptional } from '../env';
import { isSendProviderKind } from './types';
import type { SendProviderKind } from './types';
import { strategyFor, isSendRouteStrategyKind } from './strategies';
import type { ProviderEntry, ProviderHealthStatus, ResolvedRoute } from './strategies/types';

export type { ProviderHealthStatus, ResolvedRoute } from './strategies/types';

/**
 * Provider route configuration as stored in the `providerRoutes` table.
 * Kept structurally identical to the pre-deepening shape in
 * `lib/emailProviders/routing.ts` so callers don't need to retype.
 */
export interface ProviderRouteConfig {
	strategy: 'single' | 'priority_failover' | 'workload_split';
	providers: Array<{
		providerType: string;
		weight?: number;
		isEnabled: boolean;
	}>;
	ipPool?: string;
}

/**
 * Resolve a route from an org's `providerRoutes` config. Falls through to the
 * `EMAIL_PROVIDER` env var when no config is present, no providers are enabled,
 * or the chosen strategy returns null — and returns `null` (unconfigured) when
 * not even the env names a provider. Fail-closed: there is no implicit MTA
 * default, so an unconfigured instance never silently dispatches to a phantom
 * MTA. The send entry points gate on `isDeliveryConfigured()` before a send
 * ever reaches here; the `null` return is defence-in-depth.
 */
export function resolveRoute(
	routeConfig: ProviderRouteConfig | null,
	healthStatuses?: readonly ProviderHealthStatus[]
): ResolvedRoute | null {
	if (!routeConfig) return fallback();

	if (!isSendRouteStrategyKind(routeConfig.strategy)) return fallback();

	const enabledEntries: ProviderEntry[] = routeConfig.providers
		.filter((p) => p.isEnabled && isSendProviderKind(p.providerType))
		.map((p) => ({
			providerType: p.providerType as SendProviderKind,
			weight: p.weight,
			isEnabled: p.isEnabled,
		}));

	if (enabledEntries.length === 0) return fallback();

	const strategy = strategyFor(routeConfig.strategy);
	const selected = strategy.select(enabledEntries, routeConfig.ipPool, healthStatuses);
	return selected ?? fallback();
}

function fallback(): ResolvedRoute | null {
	const envProvider = getOptional('EMAIL_PROVIDER');
	if (envProvider && isSendProviderKind(envProvider)) {
		return { providerType: envProvider, source: 'env_fallback' };
	}
	return null;
}
