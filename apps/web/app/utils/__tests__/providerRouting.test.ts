import { describe, expect, it } from 'vitest';
import {
	buildTransportOptions,
	isTransportAvailable,
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
			...catalog,
			{ kind: 'retired-provider', label: 'retired-provider', isAvailable: false },
		]);
		expect(transportLabel(options, 'plugin.mail-pack.postmark')).toBe('Postmark');
		expect(isTransportAvailable(options, 'retired-provider')).toBe(false);
	});

	it('seeds the first available transport without enabling an unavailable plugin', () => {
		expect(seedRouteProviders(catalog)).toEqual([
			{ providerType: 'mta', weight: 100, isEnabled: true },
			{ providerType: 'plugin.mail-pack.postmark', weight: 100, isEnabled: false },
		]);
	});

	it('preserves route order, disables stale entries, and appends newly installed kinds', () => {
		const options = buildTransportOptions(catalog, [
			{ providerType: 'retired-provider', isEnabled: true },
		]);
		expect(
			seedRouteProviders(options, [{ providerType: 'retired-provider', weight: 30, isEnabled: true }])
		).toEqual([
			{ providerType: 'retired-provider', weight: 30, isEnabled: false },
			{ providerType: 'mta', weight: 100, isEnabled: false },
			{ providerType: 'plugin.mail-pack.postmark', weight: 100, isEnabled: false },
		]);
	});
});
