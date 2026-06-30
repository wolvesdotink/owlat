import { describe, it, expect } from 'vitest';
import { deriveVerificationVerdict } from '../lifecycle';
import type { Doc } from '../../_generated/dataModel';

type VerificationResults = NonNullable<Doc<'domains'>['verificationResults']>;

const ok = { verified: true, lastChecked: 0 } as const;
const bad = { verified: false, lastChecked: 0 } as const;

/** A fully-aligned DNS bundle: SPF + DKIM + DMARC + MAIL FROM all verified. */
function fullyAlignedDns(): VerificationResults {
	return {
		spf: ok,
		dkim: [ok],
		dmarc: ok,
		mailFrom: [ok],
	};
}

describe('deriveVerificationVerdict', () => {
	it('returns "verified" when DNS is fully aligned and the provider check passes', () => {
		expect(deriveVerificationVerdict(fullyAlignedDns(), { verified: true })).toBe('verified');
	});

	it('does not verify when DNS aligns but the provider check has not', () => {
		// No record failed and nothing is pending on the DNS side, but the
		// provider hasn't confirmed yet — that is still "pending", not verified.
		expect(deriveVerificationVerdict(fullyAlignedDns(), { verified: false })).toBe('pending');
	});

	it('fails when the provider check reports an error even with aligned DNS', () => {
		expect(
			deriveVerificationVerdict(fullyAlignedDns(), { verified: false, lastError: 'nope' }),
		).toBe('failed');
	});

	it('treats a missing (optional) SPF record as verified', () => {
		const dns: VerificationResults = { dkim: [ok], dmarc: ok };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('verified');
	});

	it('fails when a present SPF record did not verify', () => {
		const dns: VerificationResults = { spf: bad, dkim: [ok], dmarc: ok };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('failed');
	});

	it('fails when any DKIM selector failed', () => {
		const dns: VerificationResults = { spf: ok, dkim: [ok, bad], dmarc: ok };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('failed');
	});

	it('fails when DMARC failed', () => {
		const dns: VerificationResults = { spf: ok, dkim: [ok], dmarc: bad };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('failed');
	});

	it('fails when a MAIL FROM record failed', () => {
		const dns: VerificationResults = { spf: ok, dkim: [ok], dmarc: ok, mailFrom: [bad] };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('failed');
	});

	it('is pending when records are still propagating but none failed', () => {
		// DMARC simply hasn't been observed yet (absent) — not aligned, not failed.
		const dns: VerificationResults = { spf: ok, dkim: [ok] };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('pending');
	});

	it('is pending on an empty result set (nothing checked yet)', () => {
		expect(deriveVerificationVerdict({}, { verified: false })).toBe('pending');
	});

	it('ignores TLS-RPT — a failed tlsRpt does not gate or fail the verdict', () => {
		const dns: VerificationResults = { ...fullyAlignedDns(), tlsRpt: bad };
		expect(deriveVerificationVerdict(dns, { verified: true })).toBe('verified');
	});
});
