/**
 * The evidence tap's central claim, tested by cryptography instead of fixtures.
 *
 * `dkimEvidence.test.ts` pins the captured record against literal strings, which
 * proves the shape but not the POINT: that a monitor holding nothing but the
 * emitted `DkimSignatureEvidence` — years later, without the message, the
 * connection or a resolver — can rebuild the signature input and check `b=`
 * against the key in `dnsKeyRecordTxt`. Every assertion here therefore ends at
 * `crypto.verify`, so a change that switched `raw` to field bodies, dropped the
 * fold bytes, reordered a duplicate group or mangled 8-bit octets fails LOUDLY
 * rather than being papered over with updated fixture literals.
 *
 * Nothing below imports the verifier's own hashing helpers: the re-derivation is
 * written out from the RFC (canonicalize each captured field, CRLF-join, append
 * the `b=`-stripped signature field) so it cannot inherit the bug it is looking
 * for. The only shared code is the public `canon` API, which is the spec's own
 * normative operation.
 */

import { describe, it, expect } from 'vitest';
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	verify as cryptoVerify,
	type KeyObject,
} from 'crypto';
import {
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
} from '../../canon.js';
import { verifyDkim, type DkimDnsResolver } from '../verify.js';
import type { DkimSignatureEvidence } from '../evidence.js';
import { mintSignature } from './helpers/mint.js';

const DOMAIN = 'example.com';
const SELECTOR = 'sel';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const RSA_TXT = `v=DKIM1; k=rsa; p=${rsa.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')}`;

const resolver: DkimDnsResolver = async (name, rrtype) => {
	if (rrtype === 'TXT' && name === KEY_NAME) {
		return [[RSA_TXT]];
	}
	throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};

/**
 * A folded Subject plus two `X-Trace` instances: the duplicate group is what
 * makes ordering load-bearing, since `h=…:x-trace:x-trace` captures them
 * bottom-up (second, then first) rather than in document order.
 */
const HEADERS = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: round trip\r\n\twith a folded continuation',
	'X-Trace: first',
	'X-Trace: second',
];
const H_TAG = 'from:to:subject:x-trace:x-trace';
const BODY = 'Round-trip body.\r\n';

/** Read one tag's value out of a raw DKIM-Signature field, whitespace stripped. */
function tagValue(sigField: string, tag: string): string {
	// Anchor on a tag boundary so `b=` never matches the tail of `bh=`.
	const match = new RegExp(`(?:^|;)[ \t\r\n]*${tag}[ \t]*=([^;]*)`, 'i').exec(sigField);
	return (match?.[1] ?? '').replace(/[ \t\r\n]/g, '');
}

/** Rebuild the published key from the captured TXT record alone. */
function publicKeyFrom(txt: string, keyType: 'rsa' | 'ed25519'): KeyObject {
	const material = Buffer.from(tagValue(txt, 'p'), 'base64');
	const der = keyType === 'ed25519' ? Buffer.concat([ED25519_SPKI_PREFIX, material]) : material;
	return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Re-derive the signature input from the evidence record and check `b=` — the
 * whole exercise a monitor performs at a §7.2.4 challenge opening.
 *
 * `headers` defaults to the captured sequence; passing a permuted copy is how
 * the negative controls below prove the ordering is cryptographically pinned.
 */
function reverify(
	evidence: DkimSignatureEvidence,
	headers: readonly { readonly raw: string }[] = evidence.rawSignedHeaders
): boolean {
	const mode = parseCanonicalization(tagValue(evidence.dkimSignatureHeader, 'c')).header;
	const joined =
		headers.map((field) => `${canonicalizeHeaderField(field.raw, mode)}\r\n`).join('') +
		canonicalizeHeaderField(stripSignatureValue(evidence.dkimSignatureHeader), mode);
	const input = Buffer.from(joined, 'latin1');

	const signature = Buffer.from(tagValue(evidence.dkimSignatureHeader, 'b'), 'base64');
	const keyType = evidence.algorithm.startsWith('ed25519') ? 'ed25519' : 'rsa';
	const key = publicKeyFrom(evidence.dnsKeyRecordTxt, keyType);
	return keyType === 'ed25519'
		? cryptoVerify(null, createHash('sha256').update(input).digest(), key, signature)
		: cryptoVerify('sha256', input, key, signature);
}

/** Verify `message` and return the single evidence record it must emit. */
async function captureOne(
	message: Buffer,
	dns: DkimDnsResolver = resolver
): Promise<{ readonly result: string; readonly evidence: DkimSignatureEvidence }> {
	const records: DkimSignatureEvidence[] = [];
	const outcome = await verifyDkim(message, {
		resolver: dns,
		onSignatureEvidence: (e) => records.push(e),
	});
	const evidence = records[0];
	if (evidence === undefined) throw new Error('no evidence captured');
	expect(records).toHaveLength(1);
	return { result: outcome.result, evidence };
}

describe('DKIM evidence re-verifies offline (OSTR §7.2.4)', () => {
	for (const canonicalization of ['relaxed/relaxed', 'simple/simple'] as const) {
		it(`rebuilds the signature input from the evidence alone (c=${canonicalization})`, async () => {
			const message = mintSignature({
				privateKey: rsa.privateKey,
				domain: DOMAIN,
				selector: SELECTOR,
				headers: HEADERS,
				hTag: H_TAG,
				body: BODY,
				canonicalization,
			});
			const { result, evidence } = await captureOne(message);

			expect(result).toBe('pass');
			expect(reverify(evidence)).toBe(true);
		});

		it(`re-verification breaks if the duplicate group is reordered (c=${canonicalization})`, async () => {
			// The bottom-up rule is what makes `rawSignedHeaders` a canonicalization
			// SEQUENCE rather than a header block. Swapping the two `x-trace` entries
			// — exactly what a naive "write the array back out as a message" would do
			// — must destroy the signature, which is the property that stops a monitor
			// from silently adjudicating against re-reversed bytes.
			const message = mintSignature({
				privateKey: rsa.privateKey,
				domain: DOMAIN,
				selector: SELECTOR,
				headers: HEADERS,
				hTag: H_TAG,
				body: BODY,
				canonicalization,
			});
			const { evidence } = await captureOne(message);

			const swapped = [...evidence.rawSignedHeaders];
			const [second, first] = [swapped[3], swapped[4]];
			if (second === undefined || first === undefined) throw new Error('missing x-trace pair');
			expect([second.raw, first.raw]).toEqual(['X-Trace: second', 'X-Trace: first']);
			swapped[3] = first;
			swapped[4] = second;

			expect(reverify(evidence, swapped)).toBe(false);
		});
	}

	it('survives 8-bit header octets byte-for-byte (latin1 round trip)', async () => {
		// An unencoded UTF-8 Subject is the common case, and `raw` is a latin1
		// decoding of the signed octets: a consumer that re-encodes the string as
		// UTF-8 gets different bytes and the signature stops verifying. `octets` is
		// the literal wire form — C3 A4 for `ä`, no MIME encoding anywhere.
		const octets = Buffer.from('Subject: verspätet', 'utf8');
		const subject = octets.toString('latin1');
		const message = mintSignature({
			privateKey: rsa.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: ['From: Alice <alice@example.com>', subject],
			hTag: 'from:subject',
			body: BODY,
		});
		const { result, evidence } = await captureOne(message);

		expect(result).toBe('pass');
		const captured = evidence.rawSignedHeaders[1];
		if (captured === undefined) throw new Error('subject not captured');
		expect(Buffer.from(captured.raw, 'latin1')).toEqual(octets);
		// The doc-comment contract in one line: latin1 in, signed octets out.
		expect(Buffer.from(captured.raw, 'utf8')).not.toEqual(octets);
		expect(reverify(evidence)).toBe(true);
	});

	it('rebuilds an ed25519 signature from the evidence alone (RFC 8463)', async () => {
		const ed = generateKeyPairSync('ed25519');
		const spki = ed.publicKey.export({ type: 'spki', format: 'der' });
		const edTxt = `v=DKIM1; k=ed25519; p=${spki.subarray(spki.length - 32).toString('base64')}`;
		const message = mintSignature({
			privateKey: ed.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: HEADERS,
			hTag: H_TAG,
			body: BODY,
			algTag: 'ed25519-sha256',
		});
		const { result, evidence } = await captureOne(message, async (name, rrtype) => {
			if (rrtype === 'TXT' && name === KEY_NAME) {
				return [[edTxt]];
			}
			throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
		});

		expect(result).toBe('pass');
		expect(reverify(evidence)).toBe(true);
	});

	it('oversigned h=from:from re-verifies with the omitted instance omitted', async () => {
		// RFC 6376 §3.5 makes a nonexistent header the NULL input, so the second
		// `from` contributes no bytes at all. If the seam ever emitted an empty
		// `from:` pair for it instead (as OSTR spec §4.2 currently describes), a
		// monitor concatenating the array would hash one field too many and reject
		// genuine, extremely common mail.
		const message = mintSignature({
			privateKey: rsa.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: ['From: Alice <alice@example.com>', 'Subject: oversigned'],
			hTag: 'from:from:subject',
			body: BODY,
		});
		const { result, evidence } = await captureOne(message);

		expect(result).toBe('pass');
		expect(evidence.signedHeaderNames).toHaveLength(3);
		expect(evidence.rawSignedHeaders).toHaveLength(2);
		expect(reverify(evidence)).toBe(true);
		// And the spec's empty-pair reading does NOT verify.
		expect(
			reverify(evidence, [
				{ raw: 'From: Alice <alice@example.com>' },
				{ raw: 'from:' },
				...evidence.rawSignedHeaders.slice(1),
			])
		).toBe(false);
	});
});
