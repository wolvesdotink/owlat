import { describe, expect, it } from 'vitest';
import {
	buildTransportOptions,
	isTransportAvailable,
	routeProvidersForWrite,
	seedRouteProviders,
	transportLabel,
} from '../providerRouting';

const catalog = [
	{ kind: 'mta', label: 'Owlat MTA', isAvailable: true },
	{ kind: 'plugin.mail-pack.postmark', label: 'Postmark', isAvailable: false },
] as const;

describe('provider routing catalog presentation', () => {
	it('uses backend labels and retains stale route kinds as unavailable', () => {
		const options = buildTransportOptions(catalog, [
			{ providerType: 'retired-provider', isEnabled: true },
		]);
		expect(options).toEqual([
			...catalog.map((entry) => ({ ...entry, isRegistered: true })),
			{
				kind: 'retired-provider',
				label: 'retired-provider',
				isAvailable: false,
				isRegistered: false,
			},
		]);
		expect(transportLabel(options, 'plugin.mail-pack.postmark')).toBe('Postmark');
		expect(isTransportAvailable(options, 'retired-provider')).toBe(false);
	});

	it('seeds the first available transport without enabling an unavailable plugin', () => {
		const options = buildTransportOptions(catalog, []);
		expect(seedRouteProviders(options)).toEqual([
			{ providerType: 'mta', weight: 100, isEnabled: true },
			{ providerType: 'plugin.mail-pack.postmark', weight: 100, isEnabled: false },
		]);
	});

	it('preserves route order, disables stale entries, and appends newly installed kinds', () => {
		const options = buildTransportOptions(catalog, [
			{ providerType: 'retired-provider', isEnabled: true },
		]);
		expect(
			seedRouteProviders(options, [
				{ providerType: 'retired-provider', weight: 30, isEnabled: true },
			])
		).toEqual([
			{ providerType: 'retired-provider', weight: 30, isEnabled: false },
			{ providerType: 'mta', weight: 100, isEnabled: false },
			{ providerType: 'plugin.mail-pack.postmark', weight: 100, isEnabled: false },
		]);
	});

	it('omits retired entries on save without reordering or enabling surviving transports', () => {
		const options = buildTransportOptions(catalog, [
			{ providerType: 'retired-provider', weight: 30, isEnabled: true },
		]);
		const edited = seedRouteProviders(options, [
			{ providerType: 'retired-provider', weight: 30, isEnabled: true },
			{ providerType: 'plugin.mail-pack.postmark', weight: 20, isEnabled: false },
			{ providerType: 'mta', weight: 50, isEnabled: true },
		]);

		expect(routeProvidersForWrite(options, edited, 'workload_split')).toEqual([
			{ providerType: 'plugin.mail-pack.postmark', weight: 20, isEnabled: false },
			{ providerType: 'mta', weight: 50, isEnabled: true },
		]);
	});
});
