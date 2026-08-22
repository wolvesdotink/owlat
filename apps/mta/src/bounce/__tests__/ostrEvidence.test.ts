/**
 * Which signature's evidence an observer keeps, and whether it is evidence at
 * all (OSTR §7.1, §7.2, §7.3).
 *
 * A message may carry several DKIM signatures, and ANY party that handled it in
 * transit can add a valid one. Signers PREPEND their signature, so the first one
 * a verifier reports on mailing-list or gateway-forwarded mail is the LAST hop's
 * — keeping that one would let anyone who touched the mail be the party a spam
 * report names, which is the false-accusation risk §7.3 exists to bound. The
 * pick is therefore the passing signature DMARC-aligned with the From domain.
 *
 * The second property is that inadmissible records never leave the box:
 * `@owlat/ostr-observer` decides that (an `l=` tag, RSA under 2048 bits, or a
 * signature not covering From/Date/Message-ID is not evidence), and this module
 * runs it at capture rather than shipping a record a consumer would refuse.
 */

import { describe, it, expect } from 'vitest';
import type { DkimSignatureEvidence } from '@owlat/mail-auth';
import { buildOstrDkimEvidence, createOstrEvidenceCapture } from '../ostrEvidence.js';

const MESSAGE_ID = '<msg-1@author.example>';

/**
 * An admissible record: `a=rsa-sha256` over a 2048-bit key, no `l=`, covering
 * the three headers §7.1 requires, with those three retained verbatim.
 */
function evidence(overrides: Partial<DkimSignatureEvidence> = {}): DkimSignatureEvidence {
	return {
		signingDomain: 'author.example',
		selector: 's1',
		algorithm: 'rsa-sha256',
		keyBits: 2048,
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'date', 'message-id'],
		rawSignedHeaders: [
			{ name: 'from', raw: 'From: sender@author.example' },
			{ name: 'date', raw: 'Date: Thu, 20 Aug 2026 10:11:12 +0000' },
			{ name: 'message-id', raw: `Message-ID: ${MESSAGE_ID}` },
		],
		dkimSignatureHeader: 'DKIM-Signature: v=1; d=author.example; s=s1; b=AAA',
		dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIB',
		verificationVerdict: 'pass',
		bodyHash: 'bh-1',
		...overrides,
	};
}

describe('createOstrEvidenceCapture — which signature may be named', () => {
	it("keeps the aligned author's signature even when a list re-signed on top", () => {
		// Document order, i.e. the order `verifyDkim` reports in: the list signed
		// last, so its signature is FIRST. Keeping it would report the list.
		const capture = createOstrEvidenceCapture();
		capture.onSignatureEvidence(evidence({ signingDomain: 'list.example' }));
		capture.onSignatureEvidence(evidence({ signingDomain: 'author.example' }));

		expect(capture.select('author.example')?.signingDomain).toBe('author.example');
	});

	it('aligns relaxed, so a subdomain signer still answers for its own mail', () => {
		const capture = createOstrEvidenceCapture();
		capture.onSignatureEvidence(evidence({ signingDomain: 'list.example' }));
		capture.onSignatureEvidence(evidence({ signingDomain: 'mail.author.example' }));

		expect(capture.select('author.example')?.signingDomain).toBe('mail.author.example');
	});

	it('falls back to the first passing signature when none aligns', () => {
		// A message with no aligned signer is not thereby unreportable — it just
		// has no author-domain claim to prefer, so the verdict's own signature
		// (the first pass, which is what DKIM reduces to) stands.
		const capture = createOstrEvidenceCapture();
		capture.onSignatureEvidence(evidence({ signingDomain: 'gateway.example' }));
		capture.onSignatureEvidence(evidence({ signingDomain: 'list.example' }));

		expect(capture.select('author.example')?.signingDomain).toBe('gateway.example');
		expect(capture.select(undefined)?.signingDomain).toBe('gateway.example');
	});

	it('skips signatures that did not verify', () => {
		const capture = createOstrEvidenceCapture();
		capture.onSignatureEvidence(
			evidence({ signingDomain: 'forged.example', verificationVerdict: 'fail' })
		);
		capture.onSignatureEvidence(
			evidence({ signingDomain: 'unreachable.example', verificationVerdict: 'temperror' })
		);
		capture.onSignatureEvidence(evidence({ signingDomain: 'author.example' }));

		expect(capture.select(undefined)?.signingDomain).toBe('author.example');
	});

	it('keeps nothing when nothing verified', () => {
		const capture = createOstrEvidenceCapture();
		capture.onSignatureEvidence(evidence({ verificationVerdict: 'permerror' }));

		expect(capture.select('author.example')).toBeUndefined();
	});

	it('bounds what a message with many signatures can make it hold', () => {
		const capture = createOstrEvidenceCapture();
		for (let i = 0; i < 100; i++) {
			capture.onSignatureEvidence(evidence({ signingDomain: `signer-${String(i)}.example` }));
		}

		// The 90th signer is past the cap, so it can never be selected — and the
		// first one, which is what the fallback returns, still is.
		expect(capture.select('signer-90.example')?.signingDomain).toBe('signer-0.example');
	});
});

describe('buildOstrDkimEvidence', () => {
	it('adds the receiver-only facts to the verifier record', () => {
		const built = buildOstrDkimEvidence(
			evidence(),
			MESSAGE_ID,
			new Date('2026-08-20T10:11:12.000Z')
		);

		expect(built).toEqual({
			...evidence(),
			messageId: MESSAGE_ID,
			verifiedAt: '2026-08-20T10:11:12.000Z',
		});
	});

	it('produces nothing at all when no signature verified', () => {
		expect(buildOstrDkimEvidence(undefined, MESSAGE_ID, new Date(0))).toBeUndefined();
	});

	const inadmissible: Array<[string, Partial<DkimSignatureEvidence>]> = [
		// `l=` bounds how much of the body is signed, so the message shown may be
		// half unsigned — a report resting on it proves nothing (§7.1).
		['a body-length (`l=`) tag', { usesBodyLengthTag: true }],
		['an RSA key under the 2048-bit floor', { keyBits: 1024 }],
		['an unproven RSA key size', { keyBits: undefined }],
		['a collision-broken digest', { algorithm: 'rsa-sha1' }],
		[
			'a signature that does not cover Message-ID',
			{
				signedHeaderNames: ['from', 'date'],
				rawSignedHeaders: [
					{ name: 'from', raw: 'From: sender@author.example' },
					{ name: 'date', raw: 'Date: Thu, 20 Aug 2026 10:11:12 +0000' },
				],
			},
		],
	];

	for (const [label, overrides] of inadmissible) {
		it(`discards a record with ${label} instead of shipping it`, () => {
			expect(buildOstrDkimEvidence(evidence(overrides), MESSAGE_ID, new Date(0))).toBeUndefined();
		});
	}

	it('discards a message with no Message-ID at all', () => {
		// §7.3 dedupes reports on (Message-ID, `bh=`); without one there is nothing
		// to dedupe on and §7.1 requires the signature to have covered it anyway.
		expect(buildOstrDkimEvidence(evidence(), undefined, new Date(0))).toBeUndefined();
	});
});
