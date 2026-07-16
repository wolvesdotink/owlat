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

export type RouteStrategy = 'single' | 'priority_failover' | 'workload_split';

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

export function transportLabel(options: readonly TransportOption[], providerType: string): string {
	return options.find((option) => option.kind === providerType)?.label ?? providerType;
}

export function isTransportAvailable(
	options: readonly TransportOption[],
	providerType: string
): boolean {
	return options.find((option) => option.kind === providerType)?.isAvailable === true;
}
