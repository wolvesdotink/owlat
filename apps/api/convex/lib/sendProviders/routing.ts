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
	deliverabilityFallback?: {
		isEnabled: boolean;
		relayProviderType: string;
		isWarmupOverflowEnabled: boolean;
	};
}

export type DeliverabilityReason = NonNullable<ResolvedRoute['deliverabilityReason']>;

export interface DeliverabilityRouteInput {
	activeReasons: readonly Exclude<DeliverabilityReason, 'warmup_overflow'>[];
	isWarmupOverflow: boolean;
	isRelayDomainVerified: boolean;
	isGlobalBreakerOpen?: boolean;
}

export class DeliverabilityRouteError extends Error {
	readonly code: 'DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED' | 'DELIVERABILITY_RELAY_UNAVAILABLE';

	constructor(reason: 'unverified' | 'unavailable' = 'unverified') {
		super(
			reason === 'unverified'
				? 'Deliverability relay refused: verify this sending domain for the configured relay provider before enabling automatic fallback.'
				: 'Deliverability relay unavailable: enable the verified Amazon SES transport or disable automatic fallback.'
		);
		this.code =
			reason === 'unverified'
				? 'DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED'
				: 'DELIVERABILITY_RELAY_UNAVAILABLE';
		this.name = 'DeliverabilityRouteError';
	}
}

export class GlobalDeliveryCircuitOpenError extends Error {
	readonly code = 'GLOBAL_DELIVERY_CIRCUIT_OPEN';

	constructor() {
		super('Delivery is temporarily deferred by the organization-wide safety circuit.');
		this.name = 'GlobalDeliveryCircuitOpenError';
	}
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
	healthStatuses?: readonly ProviderHealthStatus[],
	isReady: (kind: SendProviderKind) => boolean = () => true,
	deliverability?: DeliverabilityRouteInput
): ResolvedRoute | null {
	if (deliverability?.isGlobalBreakerOpen) throw new GlobalDeliveryCircuitOpenError();
	if (!routeConfig) return fallback(isReady);

	if (!isSendRouteStrategyKind(routeConfig.strategy)) return fallback(isReady);

	const enabledEntries: ProviderEntry[] = routeConfig.providers
		.filter((p) => p.isEnabled && isSendProviderKind(p.providerType) && isReady(p.providerType))
		.map((p) => ({
			providerType: p.providerType as SendProviderKind,
			weight: p.weight,
			isEnabled: p.isEnabled,
		}));

	if (enabledEntries.length === 0) return fallback(isReady);

	const strategy = strategyFor(routeConfig.strategy);
	const selected = strategy.select(enabledEntries, routeConfig.ipPool, healthStatuses);
	const resolved = selected ?? fallback(isReady);
	if (!resolved) return resolved;

	const fallbackConfig = routeConfig.deliverabilityFallback;
	const isHybridRelaySelection = Boolean(
		fallbackConfig?.isEnabled &&
		resolved.providerType === fallbackConfig.relayProviderType &&
		routeConfig.providers.some((provider) => provider.isEnabled && provider.providerType === 'mta')
	);
	if (isHybridRelaySelection && !deliverability?.isRelayDomainVerified) {
		throw new DeliverabilityRouteError();
	}
	if (!deliverability) return resolved;

	const reason =
		deliverability.activeReasons[0] ??
		(fallbackConfig?.isWarmupOverflowEnabled && deliverability.isWarmupOverflow
			? 'warmup_overflow'
			: undefined);
	if (!reason || !fallbackConfig?.isEnabled) return resolved;
	if (fallbackConfig.relayProviderType !== 'ses') {
		throw new DeliverabilityRouteError('unavailable');
	}
	const relay = enabledEntries.find(
		(entry) => entry.providerType === fallbackConfig.relayProviderType
	);
	if (!relay) throw new DeliverabilityRouteError('unavailable');
	if (!deliverability.isRelayDomainVerified) throw new DeliverabilityRouteError();
	return {
		providerType: relay.providerType,
		source: 'deliverability_fallback',
		deliverabilityReason: reason,
	};
}

function fallback(isReady: (kind: SendProviderKind) => boolean): ResolvedRoute | null {
	const envProvider = getOptional('EMAIL_PROVIDER');
	if (envProvider && isSendProviderKind(envProvider) && isReady(envProvider)) {
		return { providerType: envProvider, source: 'env_fallback' };
	}
	return null;
}
