export interface TransportCatalogOption {
	readonly kind: string;
	readonly label: string;
	readonly isAvailable: boolean;
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
): readonly TransportCatalogOption[] {
	const options = new Map(catalog.map((entry) => [entry.kind, { ...entry }]));
	for (const provider of routeProviders) {
		if (!options.has(provider.providerType)) {
			options.set(provider.providerType, {
				kind: provider.providerType,
				label: provider.providerType,
				isAvailable: false,
			});
		}
	}
	return [...options.values()];
}

/** Preserve existing order, append newly installed kinds, and disable stale entries. */
export function seedRouteProviders(
	options: readonly TransportCatalogOption[],
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

export function transportLabel(
	options: readonly TransportCatalogOption[],
	providerType: string
): string {
	return options.find((option) => option.kind === providerType)?.label ?? providerType;
}

export function isTransportAvailable(
	options: readonly TransportCatalogOption[],
	providerType: string
): boolean {
	return options.find((option) => option.kind === providerType)?.isAvailable === true;
}
