/**
 * A refused campaign send names its reason by catalog key. If either locale
 * lacks that key, the operation seam falls back to the category line ("This
 * action is not available right now"), which says neither what is wrong nor
 * where to fix it. These cases pin that every reason the pre-flight can return
 * is worded in both languages and that the in-place note links each fixable
 * reason to the page it is fixed on.
 */
import { describe, expect, it } from 'vitest';
import {
	PREFLIGHT_FAILURE_REASONS,
	PREFLIGHT_MESSAGE_KEYS,
	allPreflightMessageKeys,
} from '@owlat/api/campaignRefusal';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { campaignRefusalOf, refusalFixLink } from '~/lib/campaignRefusal';

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
			catalog
		);
}

describe('campaign refusal copy', () => {
	it('names at least one key for every reason the pre-flight can return', () => {
		for (const reason of PREFLIGHT_FAILURE_REASONS) {
			expect(Object.keys(PREFLIGHT_MESSAGE_KEYS[reason]).length).toBeGreaterThan(0);
		}
	});

	it.each(allPreflightMessageKeys())('%s is worded in English and German', (key) => {
		expect(typeof lookup(en, key)).toBe('string');
		expect(typeof lookup(de, key)).toBe('string');
	});

	it('every fix link label is worded in English and German', () => {
		for (const reason of PREFLIGHT_FAILURE_REASONS) {
			const link = refusalFixLink(reason);
			if (!link) continue;
			expect(typeof lookup(en, link.labelKey)).toBe('string');
			expect(typeof lookup(de, link.labelKey)).toBe('string');
		}
	});

	it('links the reasons fixed outside the campaign to the page that fixes them', () => {
		expect(refusalFixLink('no_delivery_provider')?.to).toBe('/dashboard/admin/delivery/transport');
		expect(refusalFixLink('domain_not_verified')?.to).toBe('/dashboard/admin/delivery/domains');
		expect(refusalFixLink('sender_not_allowed')?.to).toBe('/dashboard/admin/team/senders');
		// The delivery hub carries the account-status banner.
		expect(refusalFixLink('sending_not_allowed')?.to).toBe('/dashboard/admin/delivery');
		// Fixed in the campaign itself, or not fixable by the operator.
		expect(refusalFixLink('no_template')).toBeNull();
		expect(refusalFixLink('scheduled_in_past')).toBeNull();
	});
});

describe('campaignRefusalOf', () => {
	it('reads the reason, key and parameters off a refused schedule', () => {
		expect(
			campaignRefusalOf({
				category: 'invalid_state',
				message: 'Cannot send campaign: domain "acme.com" is not verified.',
				data: {
					reason: 'domain_not_verified',
					messageKey: 'shared.campaignRefusal.domainUnverified',
					messageParams: { domain: 'acme.com' },
				},
			})
		).toEqual({
			reason: 'domain_not_verified',
			messageKey: 'shared.campaignRefusal.domainUnverified',
			params: { domain: 'acme.com' },
			message: 'Cannot send campaign: domain "acme.com" is not verified.',
		});
	});

	it('keeps the English sentence when an older backend sends no key', () => {
		expect(
			campaignRefusalOf({
				category: 'invalid_state',
				message: 'Campaign must have an audience configured',
				data: { reason: 'no_audience' },
			})
		).toEqual({
			reason: 'no_audience',
			messageKey: null,
			params: {},
			message: 'Campaign must have an audience configured',
		});
	});

	it('ignores failures that are not a pre-flight refusal', () => {
		expect(campaignRefusalOf({ category: 'invalid_state', message: 'Nope' })).toBeNull();
		expect(
			campaignRefusalOf({
				category: 'forbidden',
				message: 'No',
				data: { reason: 'no_template' },
			})
		).toBeNull();
		expect(
			campaignRefusalOf({
				category: 'invalid_state',
				message: 'x',
				data: { reason: 'something_else' },
			})
		).toBeNull();
	});
});
