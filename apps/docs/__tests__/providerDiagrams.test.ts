import { describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	isOwnSendProviderKind,
} from '@owlat/shared/sendProviderCatalog';
import {
	DELIVERY_PIPELINE_FEATURES,
	docsSendProviders,
	PROVIDER_ICONS,
	providerIcon,
} from '../app/utils/sendProviderDiagrams';

/**
 * The architecture diagrams draw their provider rows from the core catalog, so
 * a new send provider appears in all three without anyone editing a `.vue`.
 */
describe('docsSendProviders', () => {
	const { own, alternatives } = docsSendProviders();

	it('picks the own-tier MTA as the default row', () => {
		expect(own.kind).toBe('mta');
		expect(isOwnSendProviderKind(own.kind)).toBe(true);
		expect(own.icon).toBe(PROVIDER_ICONS.mta);
	});

	it('lists every other core provider once, in catalog order, under its catalog label', () => {
		const expected = CORE_SEND_PROVIDER_CATALOG_ENTRIES.filter(
			(entry) => !isOwnSendProviderKind(entry.kind)
		).map((entry) => ({ kind: entry.kind, name: entry.label }));
		expect(alternatives.map(({ kind, name }) => ({ kind, name }))).toEqual(expected);
		expect(alternatives.length).toBeGreaterThanOrEqual(5);
	});

	it('gives every row an icon, falling back to the mail icon', () => {
		for (const row of [own, ...alternatives]) expect(row.icon).not.toBe('');
		expect(providerIcon('some-future-provider')).toBe(PROVIDER_ICONS.resend);
	});
});

describe('DELIVERY_PIPELINE_FEATURES', () => {
	it('has a label and an icon per entry', () => {
		expect(DELIVERY_PIPELINE_FEATURES.map((feature) => feature.label)).toEqual([
			'DKIM signing',
			'MX delivery',
			'IP warming',
			'Rate limiting',
			'Health-aware failover',
		]);
		for (const feature of DELIVERY_PIPELINE_FEATURES) expect(feature.icon).not.toBe('');
	});
});
