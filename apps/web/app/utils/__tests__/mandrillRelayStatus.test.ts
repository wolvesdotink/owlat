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
			)
		).toEqual(['SPF', 'DKIM', 'domain ownership']);
	});

	it('keeps ownership outstanding even when both records are valid', () => {
		expect(mandrillOutstanding(identity({ verifiedAt: null }))).toEqual(['domain ownership']);
	});

	it('is empty for a fully verified domain', () => {
		expect(mandrillOutstanding(identity())).toEqual([]);
	});
});
