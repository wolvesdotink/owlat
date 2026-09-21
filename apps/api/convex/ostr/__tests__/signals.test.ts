/**
 * The OSTR wire-contract narrowing at the Convex boundary.
 *
 * Everything the MTA stamps on an inbound delivery arrives as parsed JSON that
 * nothing has validated yet, so these guards are the only thing between a bug
 * on the far side and a Convex argument-validation failure — which, on this
 * path, would be a bounced delivery for the sake of an advisory field. Hence
 * the shape of the tests: garbage narrows to `undefined`, never throws.
 */

import { describe, it, expect } from 'vitest';
import {
	isOstrFlaggedTier,
	isOstrTier,
	parseOstrDkimEvidence,
	type OstrDkimEvidence,
} from '../signals';

/** A complete, well-formed bundle — the observer-mode shape (plan §7.1). */
function evidence(): Record<string, unknown> {
	return {
		signingDomain: 'sender.example',
		selector: 's1',
		algorithm: 'rsa-sha256',
		keyBits: 2048,
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'date', 'message-id', 'subject'],
		rawSignedHeaders: [
			{ name: 'From', raw: 'From: Alice <alice@sender.example>' },
			{ name: 'Date', raw: 'Date: Thu, 20 Aug 2026 09:00:00 +0000' },
		],
		dkimSignatureHeader: 'DKIM-Signature: v=1; a=rsa-sha256; d=sender.example; s=s1; …',
		dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIBIjANBg…',
		verificationVerdict: 'pass',
		verifiedAt: '2026-08-20T09:00:01Z',
		messageId: '<m-1@sender.example>',
		bodyHash: 'uoq1oCgLlTqpdDX/iUbLy7J1Wic=',
	};
}

describe('isOstrTier', () => {
	it('accepts each of the five spec tiers', () => {
		for (const tier of ['unknown', 'establishing', 'trusted', 'warned', 'flagged']) {
			expect(isOstrTier(tier)).toBe(true);
		}
	});

	it('rejects anything that is not one of them', () => {
		for (const value of ['', 'FLAGGED', 'spam', 'trusted ', 0, 1, true, null, undefined, {}, []]) {
			expect(isOstrTier(value)).toBe(false);
		}
	});
});

describe('isOstrFlaggedTier', () => {
	it('is true for `flagged` only — no tier below it routes anything', () => {
		expect(isOstrFlaggedTier('flagged')).toBe(true);
		for (const tier of ['warned', 'trusted', 'establishing', 'unknown'] as const) {
			expect(isOstrFlaggedTier(tier)).toBe(false);
		}
		expect(isOstrFlaggedTier(undefined)).toBe(false);
	});
});

describe('parseOstrDkimEvidence', () => {
	it('accepts a complete bundle and returns it field for field', () => {
		const parsed = parseOstrDkimEvidence(evidence());
		expect(parsed).toEqual(evidence());
	});

	it('accepts a bundle without keyBits (only RSA carries one)', () => {
		const { keyBits: _dropped, ...withoutKeyBits } = evidence();
		const parsed = parseOstrDkimEvidence(withoutKeyBits);
		expect(parsed?.keyBits).toBeUndefined();
		expect(parsed?.signingDomain).toBe('sender.example');
	});

	it('drops unknown keys rather than forwarding them into a Convex validator', () => {
		const parsed = parseOstrDkimEvidence({ ...evidence(), somethingNew: 'x' });
		expect(parsed).toBeDefined();
		expect(Object.keys(parsed as OstrDkimEvidence)).not.toContain('somethingNew');
	});

	it('rejects a bundle missing any required field', () => {
		for (const key of Object.keys(evidence())) {
			if (key === 'keyBits') continue;
			const { [key]: _dropped, ...partial } = evidence();
			expect(parseOstrDkimEvidence(partial), `missing ${key}`).toBeUndefined();
		}
	});

	it('rejects wrong-typed fields', () => {
		expect(parseOstrDkimEvidence({ ...evidence(), usesBodyLengthTag: 'no' })).toBeUndefined();
		expect(parseOstrDkimEvidence({ ...evidence(), keyBits: '2048' })).toBeUndefined();
		expect(parseOstrDkimEvidence({ ...evidence(), signedHeaderNames: 'from' })).toBeUndefined();
		expect(parseOstrDkimEvidence({ ...evidence(), signedHeaderNames: [1] })).toBeUndefined();
		expect(
			parseOstrDkimEvidence({ ...evidence(), rawSignedHeaders: [{ name: 'x' }] })
		).toBeUndefined();
	});

	it('rejects non-objects without throwing', () => {
		for (const value of [undefined, null, 'evidence', 7, []]) {
			expect(parseOstrDkimEvidence(value)).toBeUndefined();
		}
	});
});
