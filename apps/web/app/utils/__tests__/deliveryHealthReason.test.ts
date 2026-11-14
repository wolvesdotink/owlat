/**
 * The delivery-health reason is printed on translated surfaces (the hub
 * header, the dashboard alert, the marketing sidebar, the audience panel). The
 * backend names it by code; these cases pin that every code is worded in both
 * languages and that the client turns a code into its sentence.
 */
import { describe, expect, it } from 'vitest';
import {
	DELIVERY_HEALTH_REASONS,
	DELIVERY_HEALTH_REASON_KEYS,
} from '@owlat/api/deliveryHealthCopy';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { deliveryHealthReasonText } from '~/utils/deliveryHealthReason';

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
			catalog
		);
}

describe('delivery health reason copy', () => {
	it.each(DELIVERY_HEALTH_REASONS)('%s is worded in English and German', (reason) => {
		const key = DELIVERY_HEALTH_REASON_KEYS[reason];
		expect(typeof lookup(en, key)).toBe('string');
		expect(typeof lookup(de, key)).toBe('string');
	});

	it('carries the held domains into the sentence', () => {
		expect(deliveryHealthReasonText('mta_signing_held', { domains: 'example.com' })).toEqual({
			key: 'shared.deliveryHealth.reasons.mtaSigningHeld',
			params: { domains: 'example.com' },
		});
	});

	it('names nothing for a code this build does not know', () => {
		expect(deliveryHealthReasonText('a_newer_reason')).toBeNull();
		expect(deliveryHealthReasonText(undefined)).toBeNull();
	});
});
