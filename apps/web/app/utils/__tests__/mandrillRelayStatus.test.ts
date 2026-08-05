import { describe, expect, it } from 'vitest';
import {
	isMandrillProofFresh,
	mandrillOutstanding,
	mandrillRelayDisplay,
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

describe('mandrillRelayDisplay', () => {
	it('reads verified only while the proof is inside the freshness bound', () => {
		const display = mandrillRelayDisplay(identity(), NOW);
		expect(display.label).toBe('Verified');
		expect(display.tone).toBe('success');
		expect(display.isProofStale).toBe(false);
	});

	it('reads "re-checking", not verified, once the proof has aged out', () => {
		// The bound routing applies (`MANDRILL_RELAY_PROOF_MAX_AGE_MS`). Saying
		// "verified" here would claim the relay is usable at the exact moment
		// routing stopped trusting it.
		const stale = mandrillRelayDisplay(identity({ lastCheckedAt: NOW - WEEK - 1 }), NOW);
		expect(stale.label).toBe('Re-checking');
		expect(stale.isProofStale).toBe(true);
		expect(stale.tone).toBe('warning');
		expect(stale.summary).toContain('nothing for you to do');
	});

	it('treats exactly the bound as still fresh', () => {
		expect(mandrillRelayDisplay(identity({ lastCheckedAt: NOW - WEEK }), NOW).label).toBe(
			'Verified'
		);
	});

	it('distinguishes "nothing published yet" from "waiting on DNS"', () => {
		expect(
			mandrillRelayDisplay(identity({ status: 'unverified', verifiedAt: null }), NOW).label
		).toBe('Not published yet');
		expect(
			mandrillRelayDisplay(identity({ status: 'pending_dns', verifiedAt: null }), NOW).label
		).toBe('Waiting on DNS');
	});

	it('names a rejected credential as a key problem, not a DNS problem', () => {
		const display = mandrillRelayDisplay(
			identity({ status: 'failed', verifiedAt: null, lastError: 'Invalid API key' }),
			NOW
		);
		expect(display.tone).toBe('error');
		expect(display.summary).toContain('Your published DNS is untouched');
	});

	it('flags outstanding ownership on every unverified state', () => {
		for (const status of ['unverified', 'pending_dns', 'failed'] as const) {
			expect(mandrillRelayDisplay(identity({ status, verifiedAt: null }), NOW).needsOwnership).toBe(
				true
			);
		}
		expect(mandrillRelayDisplay(identity(), NOW).needsOwnership).toBe(false);
	});
});

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
