/**
 * The tracking-domain row's status and last-check message: every state the
 * backend can leave a row in reads as one badge and, after a failed check,
 * copy naming the half that failed, in both locales.
 */
import { describe, expect, it } from 'vitest';
import { trackingDomainCheckMessageKey, trackingDomainStatus } from '../trackingDomainStatus';
import type { TrackingDomainCheckOutcome } from '../trackingDomainStatus';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

const AT = Date.UTC(2026, 10, 1, 12, 0, 0);

describe('trackingDomainStatus', () => {
	it('is pending until the first verification', () => {
		expect(trackingDomainStatus({ isVerified: false })).toBe('pending');
	});

	it('is verified while the checks pass', () => {
		expect(trackingDomainStatus({ isVerified: true, verifiedAt: AT })).toBe('verified');
	});

	it('is failing while a verified domain waits for its confirming check', () => {
		expect(
			trackingDomainStatus({ isVerified: true, verifiedAt: AT, regressionSuspectedAt: AT })
		).toBe('failing');
	});

	it('is lapsed once a verified domain stopped verifying', () => {
		expect(trackingDomainStatus({ isVerified: false, verifiedAt: AT })).toBe('lapsed');
	});
});

describe('trackingDomainCheckMessageKey', () => {
	const failed: TrackingDomainCheckOutcome[] = [
		'dns_mismatch',
		'https_unreachable',
		'https_wrong_response',
		'inconclusive',
	];

	it('says nothing when the last check passed or none ran', () => {
		expect(trackingDomainCheckMessageKey({ isVerified: false })).toBeNull();
		expect(
			trackingDomainCheckMessageKey({
				isVerified: true,
				lastCheck: { at: AT, outcome: 'verified' },
			})
		).toBeNull();
	});

	it('names a distinct, translated message for each failed outcome', () => {
		const keys = failed.map((outcome) =>
			trackingDomainCheckMessageKey({ isVerified: false, lastCheck: { at: AT, outcome } })
		);
		expect(new Set(keys).size).toBe(failed.length);
		for (const messages of [en, de]) {
			for (const key of keys) {
				const copy = (key ?? '')
					.split('.')
					.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
				expect(typeof copy).toBe('string');
			}
		}
	});
});
