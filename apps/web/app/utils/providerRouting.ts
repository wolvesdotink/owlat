import { isOwnSendProviderKind } from '@owlat/shared';
import type { ProviderRouteStrategy } from './providerRouteOptions';

export interface TransportCatalogOption {
	readonly kind: string;
	readonly label: string;
	readonly isAvailable: boolean;
}

export interface TransportOption extends TransportCatalogOption {
	/** True when the backend still recognizes this transport kind. */
	readonly isRegistered: boolean;
}

export interface RouteProviderEntry {
	readonly providerType: string;
	readonly weight?: number;
	readonly isEnabled: boolean;
}

/** Merge the composed catalog with retired/stale kinds still present in routes. */
export function buildTransportOptions(
	catalog: readonly TransportCatalogOption[],
	routeProviders: readonly RouteProviderEntry[]
): readonly TransportOption[] {
	const options = new Map(catalog.map((entry) => [entry.kind, { ...entry, isRegistered: true }]));
	for (const provider of routeProviders) {
		if (!options.has(provider.providerType)) {
			options.set(provider.providerType, {
				kind: provider.providerType,
				label: provider.providerType,
				isAvailable: false,
				isRegistered: false,
			});
		}
	}
	return [...options.values()];
}

/** Preserve existing order, append newly installed kinds, and disable stale entries. */
export function seedRouteProviders(
	options: readonly TransportOption[],
	existing?: readonly RouteProviderEntry[]
): RouteProviderEntry[] {
	const optionByKind = new Map(options.map((option) => [option.kind, option]));
	if (!existing) {
		let hasEnabledProvider = false;
		return options.map((option) => {
			const isEnabled = option.isAvailable && !hasEnabledProvider;
			if (isEnabled) hasEnabledProvider = true;
			return { providerType: option.kind, weight: 100, isEnabled };
		});
	}

	const providers = existing.map((provider) => ({
		...provider,
		isEnabled: provider.isEnabled && optionByKind.get(provider.providerType)?.isAvailable === true,
	}));
	const existingKinds = new Set(existing.map((provider) => provider.providerType));
	for (const option of options) {
		if (!existingKinds.has(option.kind)) {
			providers.push({ providerType: option.kind, weight: 100, isEnabled: false });
		}
	}
	return providers;
}

/**
 * The strategy union, sourced from the option module rather than re-spelled:
 * only `workload_split` carries per-provider weights, and a second copy of the
 * union is a copy that will be missed when a kind is added.
 */
export type RouteStrategy = ProviderRouteStrategy;

/**
 * Canonical write form: keep registered transports in their edited order and
 * discard retired kinds. Availability never changes enablement here, so a
 * serializer cannot silently activate a transport.
 */
export function routeProvidersForWrite(
	options: readonly TransportOption[],
	providers: readonly RouteProviderEntry[],
	strategy: RouteStrategy
): RouteProviderEntry[] {
	const registeredKinds = new Set(
		options.filter((option) => option.isRegistered).map((option) => option.kind)
	);
	return providers
		.filter((provider) => registeredKinds.has(provider.providerType))
		.map((provider) => ({
			providerType: provider.providerType,
			...(strategy === 'workload_split'
				? { weight: Math.max(0, Math.round(provider.weight ?? 0)) }
				: {}),
			isEnabled: provider.isEnabled,
		}));
}

/**
 * WHICH TRANSPORTS MAY BE THE DELIVERABILITY-FALLBACK RELAY — the browser's
 * copy of `lib/sendProviders/fallbackEligibility.ts` (plan D6).
 *
 * The rule is a CAPABILITY, not a name: any configured transport that is not
 * our own MTA. The MTA is the arm a fallback moves traffic away from, so routing
 * it to itself would relieve a reputation problem through the transport that has
 * it. The shipped screen asked `providerType === 'ses'` instead — a list of one
 * — so a deployment migrating from Mandrill could save the route the backend
 * would happily have accepted only by never using this screen.
 *
 * Enablement stands in for "configured" here on purpose: the route editor
 * already disables the checkbox of an unavailable transport and `seedRouteProviders`
 * un-enables a stale one, so an enabled entry is one the catalog vouched for.
 */
export function eligibleFallbackRelays(
	providers: readonly RouteProviderEntry[]
): RouteProviderEntry[] {
	return providers.filter(
		(provider) => provider.isEnabled && !isOwnSendProviderKind(provider.providerType)
	);
}

/**
 * The refusal this fallback configuration would earn, or null when it would
 * save.
 *
 * The sentences are the BACKEND'S, verbatim (`providerRoutes.setRoute`), for the
 * reason the backend keeps one predicate for two callers: a client-side guard
 * that phrases the same refusal differently teaches the operator a rule that
 * does not exist. Checked in the same order the mutation checks them, so the
 * first thing they read is the first thing it would complain about.
 */
export function fallbackRelayIssue(
	providers: readonly RouteProviderEntry[],
	relayProviderType: string
): string | null {
	if (relayProviderType === '' || isOwnSendProviderKind(relayProviderType)) {
		return 'Deliverability fallback relay must be a configured non-MTA transport';
	}
	if (!eligibleFallbackRelays(providers).some((p) => p.providerType === relayProviderType)) {
		return 'Deliverability fallback relay must be enabled in this route';
	}
	if (!providers.some((p) => p.isEnabled && isOwnSendProviderKind(p.providerType))) {
		return 'Deliverability fallback requires an enabled owned-MTA route';
	}
	return null;
}

export function transportLabel(options: readonly TransportOption[], providerType: string): string {
	return options.find((option) => option.kind === providerType)?.label ?? providerType;
}

export function isTransportAvailable(
	options: readonly TransportOption[],
	providerType: string
): boolean {
	return options.find((option) => option.kind === providerType)?.isAvailable === true;
}
