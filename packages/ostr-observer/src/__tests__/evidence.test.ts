import { describe, expect, it } from 'vitest';
import { canonicalize } from '@owlat/ostr-core';
import { buildEvidenceBundle, hashEvidenceBundle, type EvidenceInput } from '../evidence.js';

/** A signature that clears every §7.1 admissibility rule, captured completely. */
function admissibleInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
	return {
		rawSignedHeaders: [
			{ name: 'From', raw: 'From: Sales <sales@example.com>' },
			{ name: 'To', raw: 'To: user@hinterland.camp' },
			{ name: 'Subject', raw: 'Subject: Your invoice' },
			{ name: 'Date', raw: 'Date: Wed, 19 Aug 2026 09:14:02 +0000' },
			{ name: 'Message-ID', raw: 'Message-ID: <abc123@example.com>' },
		],
		dkimSignatureHeader:
			'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel1;\r\n h=from:to:subject:date:message-id; bh=2jmj7l5rSw0yVb/vlWAYkK/YBwk=; b=Zm9v',
		dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A',
		verificationVerdict: 'pass',
		verifiedAt: '2026-08-19T09:14:07Z',
		messageId: '<abc123@example.com>',
		bodyHash: '2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
		signingDomain: 'example.com',
		selector: 'sel1',
		algorithm: 'rsa-sha256',
		keyBits: 2048,
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'to', 'subject', 'date', 'message-id'],
		...overrides,
	};
}

describe('buildEvidenceBundle admissibility gating (§7.1)', () => {
	it('accepts a complete, admissible capture', () => {
		const result = buildEvidenceBundle(admissibleInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundle.signingDomain).toBe('example.com');
		expect(result.bundle.verificationVerdict).toBe('pass');
		expect(result.bundleHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses an l= body-length signature', () => {
		const result = buildEvidenceBundle(admissibleInput({ usesBodyLengthTag: true }));
		expect(result).toEqual({ ok: false, reasons: ['body-length-tag'] });
	});

	it('refuses an unproven absence of l=', () => {
		const result = buildEvidenceBundle(
			admissibleInput({ usesBodyLengthTag: undefined as unknown as boolean })
		);
		expect(result).toEqual({ ok: false, reasons: ['body-length-tag'] });
	});

	it('refuses a sub-2048-bit RSA key', () => {
		const result = buildEvidenceBundle(admissibleInput({ keyBits: 1024 }));
		expect(result).toEqual({ ok: false, reasons: ['weak-rsa-key'] });
	});

	it('refuses an RSA signature with an unknown key size', () => {
		const result = buildEvidenceBundle(admissibleInput({ keyBits: undefined }));
		expect(result).toEqual({ ok: false, reasons: ['unknown-rsa-key-size'] });
	});

	it('refuses sha1 and unknown algorithms', () => {
		expect(buildEvidenceBundle(admissibleInput({ algorithm: 'rsa-sha1' }))).toEqual({
			ok: false,
			reasons: ['weak-hash'],
		});
		expect(buildEvidenceBundle(admissibleInput({ algorithm: 'dsa-sha256' }))).toEqual({
			ok: false,
			reasons: ['unsupported-algorithm'],
		});
	});

	it('refuses a signature not covering From, Date or Message-ID', () => {
		const missing = (names: string[]) =>
			buildEvidenceBundle(admissibleInput({ signedHeaderNames: names }));
		expect(missing(['to', 'subject', 'date', 'message-id'])).toEqual({
			ok: false,
			reasons: ['unsigned-from'],
		});
		expect(missing(['from', 'subject', 'message-id'])).toEqual({
			ok: false,
			reasons: ['unsigned-date'],
		});
		expect(missing(['from', 'date'])).toEqual({ ok: false, reasons: ['unsigned-message-id'] });
		expect(missing([])).toEqual({
			ok: false,
			reasons: ['unsigned-from', 'unsigned-date', 'unsigned-message-id'],
		});
	});

	it('short-circuits on inadmissibility rather than mixing in capture reasons', () => {
		const result = buildEvidenceBundle(
			admissibleInput({ usesBodyLengthTag: true, verificationVerdict: 'fail', messageId: '' })
		);
		expect(result).toEqual({ ok: false, reasons: ['body-length-tag'] });
	});

	it('accepts ed25519 without a key size', () => {
		const result = buildEvidenceBundle(
			admissibleInput({ algorithm: 'ed25519-sha256', keyBits: undefined })
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bundle.keyBits).toBeUndefined();
	});
});

describe('buildEvidenceBundle capture completeness (§7.2)', () => {
	it('refuses a verdict other than pass', () => {
		const result = buildEvidenceBundle(admissibleInput({ verificationVerdict: 'temperror' }));
		expect(result).toEqual({ ok: false, reasons: ['verification-not-pass'] });
	});

	it('refuses a capture missing the verbatim bytes of a required header', () => {
		const result = buildEvidenceBundle(
			admissibleInput({
				rawSignedHeaders: [
					{ name: 'From', raw: 'From: Sales <sales@example.com>' },
					{ name: 'Date', raw: 'Date: Wed, 19 Aug 2026 09:14:02 +0000' },
				],
			})
		);
		expect(result).toEqual({ ok: false, reasons: ['missing-signed-header-bytes'] });
	});

	it('refuses a capture retaining a header the signature did not cover', () => {
		const input = admissibleInput();
		const result = buildEvidenceBundle({
			...input,
			rawSignedHeaders: [
				...input.rawSignedHeaders,
				{ name: 'Received', raw: 'Received: from mta.example.com by mx.hinterland.camp' },
			],
		});
		expect(result).toEqual({ ok: false, reasons: ['unsigned-header-retained'] });
	});

	it('tolerates an oversigned name with no header on the message', () => {
		const input = admissibleInput();
		const result = buildEvidenceBundle({
			...input,
			signedHeaderNames: [...input.signedHeaderNames, 'from', 'cc'],
		});
		expect(result.ok).toBe(true);
	});

	it('refuses missing DKIM-Signature, DNS record and identity fields', () => {
		expect(buildEvidenceBundle(admissibleInput({ dkimSignatureHeader: '  ' }))).toEqual({
			ok: false,
			reasons: ['missing-dkim-signature-header'],
		});
		expect(buildEvidenceBundle(admissibleInput({ dnsKeyRecordTxt: '' }))).toEqual({
			ok: false,
			reasons: ['missing-dns-key-record'],
		});
		expect(buildEvidenceBundle(admissibleInput({ signingDomain: 'not a domain' }))).toEqual({
			ok: false,
			reasons: ['invalid-signing-domain'],
		});
		expect(buildEvidenceBundle(admissibleInput({ selector: 'sel 1' }))).toEqual({
			ok: false,
			reasons: ['invalid-selector'],
		});
		expect(buildEvidenceBundle(admissibleInput({ verifiedAt: '19/08/2026' }))).toEqual({
			ok: false,
			reasons: ['invalid-verified-at'],
		});
		expect(buildEvidenceBundle(admissibleInput({ messageId: '' }))).toEqual({
			ok: false,
			reasons: ['invalid-message-id'],
		});
		expect(buildEvidenceBundle(admissibleInput({ bodyHash: '' }))).toEqual({
			ok: false,
			reasons: ['invalid-body-hash'],
		});
	});

	it('keeps the retained headers byte-for-byte and the body nowhere', () => {
		const result = buildEvidenceBundle(admissibleInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundle.signedHeaders[0]).toEqual({
			name: 'From',
			raw: 'From: Sales <sales@example.com>',
		});
		expect(canonicalize(result.bundle)).not.toContain('body"');
		expect(Object.keys(result.bundle).sort()).toEqual([
			'algorithm',
			'bodyHash',
			'dkimSignatureHeader',
			'dnsKeyRecordTxt',
			'keyBits',
			'messageId',
			'selector',
			'signedHeaderNames',
			'signedHeaders',
			'signingDomain',
			'v',
			'verificationVerdict',
			'verifiedAt',
		]);
	});
});

describe('bundle hash stability', () => {
	it('matches the pinned golden hash', () => {
		const result = buildEvidenceBundle(admissibleInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundleHash).toBe(
			'791144312285bdb48185a8544f6e4b2d9d70c9fd6bcaaae88cf09169a7769811'
		);
	});

	it('does not depend on the input key order or on re-serialization', () => {
		const first = buildEvidenceBundle(admissibleInput());
		const reordered: EvidenceInput = {
			signedHeaderNames: ['FROM', 'To', 'SUBJECT', 'Date', 'Message-ID'],
			usesBodyLengthTag: false,
			keyBits: 2048,
			algorithm: 'RSA-SHA256',
			selector: 'sel1',
			signingDomain: 'EXAMPLE.com.',
			bodyHash: '2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
			messageId: '<abc123@example.com>',
			verifiedAt: '2026-08-19T09:14:07Z',
			verificationVerdict: 'pass',
			dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A',
			dkimSignatureHeader: admissibleInput().dkimSignatureHeader,
			rawSignedHeaders: admissibleInput().rawSignedHeaders,
		};
		const second = buildEvidenceBundle(reordered);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.bundleHash).toBe(first.bundleHash);
		expect(hashEvidenceBundle(JSON.parse(JSON.stringify(first.bundle)))).toBe(first.bundleHash);
	});

	it('changes when any retained byte changes', () => {
		const base = buildEvidenceBundle(admissibleInput());
		const tweaked = buildEvidenceBundle(
			admissibleInput({
				rawSignedHeaders: [
					{ name: 'From', raw: 'From: Sales  <sales@example.com>' },
					{ name: 'To', raw: 'To: user@hinterland.camp' },
					{ name: 'Subject', raw: 'Subject: Your invoice' },
					{ name: 'Date', raw: 'Date: Wed, 19 Aug 2026 09:14:02 +0000' },
					{ name: 'Message-ID', raw: 'Message-ID: <abc123@example.com>' },
				],
			})
		);
		expect(base.ok && tweaked.ok).toBe(true);
		if (!base.ok || !tweaked.ok) return;
		expect(tweaked.bundleHash).not.toBe(base.bundleHash);
	});
});
