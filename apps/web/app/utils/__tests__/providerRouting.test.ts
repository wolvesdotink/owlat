import { describe, expect, it } from 'vitest';
import {
	buildTransportOptions,
	eligibleFallbackRelays,
	fallbackRelayIssue,
	isTransportAvailable,
	routeProvidersForWrite,
	seedRouteProviders,
	transportLabel,
} from '../providerRouting';
import { createTestI18n } from '~/__tests__/i18n';

const catalog = [
	{ kind: 'mta', label: 'Owlat MTA', isAvailable: true },
	{ kind: 'plugin.mail-pack.postmark', label: 'Postmark', isAvailable: false },
] as const;

// `fallbackRelayIssue` hands back the refusal's message key (it is a pure
// module); the sentence an operator reads comes from the real catalog.
const { t } = createTestI18n().global;
const refusal = (issue: string | null) => (issue === null ? null : t(issue));

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

describe('deliverability-fallback relay eligibility (plan D6)', () => {
	const providers = [
		{ providerType: 'mta', isEnabled: true },
		{ providerType: 'ses', isEnabled: false },
		{ providerType: 'mandrill', isEnabled: true },
	];

	it('offers every enabled non-MTA transport and never the owned MTA', () => {
		expect(eligibleFallbackRelays(providers).map((p) => p.providerType)).toEqual(['mandrill']);
	});

	it('accepts a Mandrill migration route the shipped SES-only guard refused', () => {
		expect(fallbackRelayIssue(providers, 'mandrill')).toBeNull();
	});

	it('refuses the owned MTA with the backend’s own sentence', () => {
		expect(refusal(fallbackRelayIssue(providers, 'mta'))).toBe(
			'Deliverability fallback relay must be a configured non-MTA transport'
		);
		expect(refusal(fallbackRelayIssue(providers, ''))).toBe(
			'Deliverability fallback relay must be a configured non-MTA transport'
		);
	});

	it('refuses a relay that is not enabled in this route', () => {
		expect(refusal(fallbackRelayIssue(providers, 'ses'))).toBe(
			'Deliverability fallback relay must be enabled in this route'
		);
	});

	it('refuses a route with no owned MTA to fall back FROM', () => {
		expect(
			refusal(
				fallbackRelayIssue(
					[
						{ providerType: 'mta', isEnabled: false },
						{ providerType: 'mandrill', isEnabled: true },
					],
					'mandrill'
				)
			)
		).toBe('Deliverability fallback requires an enabled owned-MTA route');
	});
});
