/**
 * The readiness half the "Migrate from Mailchimp/Mandrill" flow asks about.
 *
 * The DISPLAY cases that used to head this file moved with the code they cover,
 * to `relayDomainDisplay.test.ts`: one panel now words every relay's state from
 * the row's catalog label, so the judgements are pinned once against the generic
 * module rather than once per vendor.
 */
import { describe, expect, it } from 'vitest';
import {
	isMandrillProofFresh,
	mandrillOutstanding,
	type MandrillRelayIdentityInput,
} from '../mandrillRelayStatus';
import { createTestI18n } from '~/__tests__/i18n';

// The outstanding items come back as message keys — this module is module scope
// and never calls `useI18n` — so the words are resolved through the real catalog.
const { t } = createTestI18n().global;

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 5, 12);

function identity(over: Partial<MandrillRelayIdentityInput> = {}): MandrillRelayIdentityInput {
	return {
		domain: 'example.com',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		verifiedAt: NOW - 1000,
		lastError: null,
		lastCheckedAt: NOW - 1000,
		nextCheckDueAt: NOW + 60_000,
		proofMaxAgeMs: WEEK,
		...over,
	};
}

describe('isMandrillProofFresh', () => {
	it('rejects a check timestamped in the future', () => {
		// An unexplainable clock is not evidence — fail closed, like routing does.
		expect(isMandrillProofFresh({ lastCheckedAt: NOW + 1, proofMaxAgeMs: WEEK }, NOW)).toBe(false);
	});
});

describe('mandrillOutstanding', () => {
	it('lists the three items in the order an operator works them', () => {
		expect(
			mandrillOutstanding(
				identity({ spf: { isValid: false }, dkim: { isValid: false }, verifiedAt: null })
			).map((key) => t(key))
		).toEqual(['SPF', 'DKIM', 'domain ownership']);
	});

	it('keeps ownership outstanding even when both records are valid', () => {
		expect(mandrillOutstanding(identity({ verifiedAt: null })).map((key) => t(key))).toEqual([
			'domain ownership',
		]);
	});

	it('is empty for a fully verified domain', () => {
		expect(mandrillOutstanding(identity())).toEqual([]);
	});
});
