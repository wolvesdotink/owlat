/**
 * The OSTR §7.2 DKIM evidence tap.
 *
 * An observer assembling an evidence bundle has to be able to re-derive the
 * verdict from the captured bytes alone, so the two properties under test are
 * FIDELITY and INERTNESS:
 *
 *   - Fidelity: `rawSignedHeaders` carries the verbatim header fields that were
 *     actually hashed — byte-exact, folds intact, duplicates resolved by DKIM's
 *     bottom-up last-instance rule — together with the key record and `bh=` the
 *     check used.
 *   - Inertness: the tap is passive. It fires on fail as well as pass, a
 *     callback that throws changes nothing, and omitting the callback leaves
 *     verification bit-identical (the rest of the suite runs without one).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { verifyDkim, type DkimDnsResolver } from '../verify.js';
import type { DkimSignatureEvidence } from '../../index.js';
import { mintSignature } from './helpers/mint.js';

const DOMAIN = 'example.com';
const SELECTOR = 'sel';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

/** The base64 SPKI body of a PEM public key — the `p=` tag's payload. */
function pemToBase64(pem: string): string {
	return pem
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replace(/\s+/g, '');
}

/** Raw 32-byte Ed25519 public key (base64) — what RFC 8463 publishes in `p=`. */
function ed25519RawBase64(publicKey: KeyObject): string {
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	return spki.subarray(spki.length - 32).toString('base64');
}

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const txtRecord = `v=DKIM1; k=rsa; p=${pemToBase64(rsa.publicKey)}`;

/** Serve `records` (already grouped into TXT character-strings) for the selector. */
function resolverServing(records: string[][]): DkimDnsResolver {
	return async (name, rrtype) => {
		if (rrtype === 'TXT' && name === KEY_NAME) {
			return records;
		}
		throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
	};
}

const resolver = resolverServing([[txtRecord]]);

/** A folded Subject and a repeated X-Trace — the two shapes evidence must survive. */
const FOLDED_SUBJECT = 'Subject: evidence fixture\r\n\twith a folded continuation';
const HEADERS = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	FOLDED_SUBJECT,
	'X-Trace: first',
	'X-Trace: second',
];
const H_TAG = 'from:to:subject:x-trace:x-trace';
const BODY = 'Evidence body.\r\n';

function sign(
	opts: {
		readonly bogusSignature?: string;
		readonly extraTags?: string;
		readonly bodyLimit?: number;
	} = {}
): Buffer {
	return mintSignature({
		privateKey: rsa.privateKey,
		domain: DOMAIN,
		selector: SELECTOR,
		headers: HEADERS,
		hTag: H_TAG,
		body: BODY,
		...opts,
	});
}

/** The raw DKIM-Signature field mint prepended (always the first, unfolded line). */
function signatureHeaderOf(message: Buffer): string {
	const first = message.toString('latin1').split('\r\n')[0];
	return first ?? '';
}

/** The `bh=` value the signer published. */
function bodyHashOf(message: Buffer): string {
	return /bh=([^;]+);/.exec(signatureHeaderOf(message))?.[1] ?? '';
}

/** Verify `message`, collecting every evidence record the tap emits. */
async function capture(
	message: Buffer,
	opts: { readonly resolver?: DkimDnsResolver } = {}
): Promise<{ readonly result: string; readonly evidence: DkimSignatureEvidence[] }> {
	const evidence: DkimSignatureEvidence[] = [];
	const outcome = await verifyDkim(message, {
		resolver: opts.resolver ?? resolver,
		onSignatureEvidence: (e) => evidence.push(e),
	});
	return { result: outcome.result, evidence };
}

describe('DKIM signature evidence capture (OSTR §7.2)', () => {
	it('captures the verbatim signed headers of a passing signature', async () => {
		const message = sign();
		const { result, evidence } = await capture(message);

		expect(result).toBe('pass');
		expect(evidence).toHaveLength(1);
		const e = evidence[0];
		if (e === undefined) throw new Error('no evidence captured');

		expect(e.verificationVerdict).toBe('pass');
		expect(e.signingDomain).toBe(DOMAIN);
		expect(e.selector).toBe(SELECTOR);
		expect(e.algorithm).toBe('rsa-sha256');
		expect(e.keyBits).toBe(2048);
		expect(e.usesBodyLengthTag).toBe(false);
		expect(e.dnsKeyRecordTxt).toBe(txtRecord);
		expect(e.dkimSignatureHeader).toBe(signatureHeaderOf(message));
		expect(e.bodyHash).toBe(bodyHashOf(message));
		expect(e.signedHeaderNames).toEqual(['from', 'to', 'subject', 'x-trace', 'x-trace']);
	});

	it('reproduces folded fields and duplicate names byte-exactly, in h= order', async () => {
		const { evidence } = await capture(sign());
		const e = evidence[0];
		if (e === undefined) throw new Error('no evidence captured');

		// Bottom-up per name: the FIRST `x-trace` in h= consumes the LAST header.
		expect(e.rawSignedHeaders).toEqual([
			{ name: 'from', raw: 'From: Alice <alice@example.com>' },
			{ name: 'to', raw: 'To: Bob <bob@example.org>' },
			{ name: 'subject', raw: FOLDED_SUBJECT },
			{ name: 'x-trace', raw: 'X-Trace: second' },
			{ name: 'x-trace', raw: 'X-Trace: first' },
		]);
		// The fold is preserved verbatim — CRLF + the original leading tab.
		expect(e.rawSignedHeaders[2]?.raw).toContain('\r\n\twith a folded continuation');
	});

	it('oversigning: an h= name with no remaining header contributes no raw field', async () => {
		const message = mintSignature({
			privateKey: rsa.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: ['From: Alice <alice@example.com>', 'Subject: oversigned'],
			hTag: 'from:from:subject',
			body: BODY,
		});
		const { result, evidence } = await capture(message);
		const e = evidence[0];
		if (e === undefined) throw new Error('no evidence captured');

		expect(result).toBe('pass');
		expect(e.signedHeaderNames).toEqual(['from', 'from', 'subject']);
		expect(e.rawSignedHeaders.map((h) => h.raw)).toEqual([
			'From: Alice <alice@example.com>',
			'Subject: oversigned',
		]);
	});

	it('fires with the verdict on the FAIL path too', async () => {
		// A bogus `b=` reaches DNS and the crypto check, then fails.
		const { result, evidence } = await capture(sign({ bogusSignature: 'Zm9vYmFy' }));

		expect(result).toBe('fail');
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.verificationVerdict).toBe('fail');
		expect(evidence[0]?.keyBits).toBe(2048);
		expect(evidence[0]?.dnsKeyRecordTxt).toBe(txtRecord);
	});

	it('records an l= signature as body-length-tagged and neutral', async () => {
		// Sign an empty body prefix (`l=0`) so the body hash matches and the D2 cap,
		// not a mismatch, decides the verdict.
		const { result, evidence } = await capture(sign({ extraTags: 'l=0; ', bodyLimit: 0 }));

		expect(result).toBe('neutral');
		expect(evidence[0]?.verificationVerdict).toBe('neutral');
		expect(evidence[0]?.usesBodyLengthTag).toBe(true);
	});

	it('fires with an empty key record when the DNS lookup finds nothing', async () => {
		const empty: DkimDnsResolver = async () => {
			throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
		};
		const { result, evidence } = await capture(sign(), { resolver: empty });

		expect(result).toBe('permerror');
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.verificationVerdict).toBe('permerror');
		expect(evidence[0]?.dnsKeyRecordTxt).toBe('');
		expect(evidence[0]?.keyBits).toBeUndefined();
	});

	it('captures the key record actually USED, not the first one returned', async () => {
		// `_domainkey` routinely carries several TXT records mid-rotation. A monitor
		// re-verifies the signature against `dnsKeyRecordTxt` years later, so
		// capturing a sibling record instead of the one the check consumed yields
		// evidence that silently cannot be reproduced.
		const stale = 'v=spf1 -all';
		const unsupported = 'v=DKIM1; k=ecdsa; p=QUFBQQ==';
		const { result, evidence } = await capture(sign(), {
			resolver: resolverServing([[stale], [unsupported], [txtRecord]]),
		});

		expect(result).toBe('pass');
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.dnsKeyRecordTxt).toBe(txtRecord);
	});

	it('reports ed25519 key size as the fixed 256 bits', async () => {
		const ed = generateKeyPairSync('ed25519');
		const message = mintSignature({
			privateKey: ed.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: HEADERS,
			hTag: H_TAG,
			body: BODY,
			algTag: 'ed25519-sha256',
		});
		const edTxt = `v=DKIM1; k=ed25519; p=${ed25519RawBase64(ed.publicKey)}`;
		const { result, evidence } = await capture(message, {
			resolver: resolverServing([[edTxt]]),
		});

		expect(result).toBe('pass');
		expect(evidence[0]?.algorithm).toBe('ed25519-sha256');
		// Ed25519 keys carry no modulus length; RFC 8032 §5.1 fixes them at 256 bits.
		expect(evidence[0]?.keyBits).toBe(256);
	});

	it('still reports keyBits for a weak RSA key the RFC 8301 floor rejects', async () => {
		// The key size is recorded BEFORE the <1024-bit policy check, deliberately:
		// `weak-rsa-key` is exactly the admissibility decision a consumer needs the
		// bits to make, so a policy `fail` must still carry them.
		const weak = generateKeyPairSync('rsa', {
			modulusLength: 512,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const message = mintSignature({
			privateKey: weak.privateKey,
			domain: DOMAIN,
			selector: SELECTOR,
			headers: HEADERS,
			hTag: H_TAG,
			body: BODY,
		});
		const { result, evidence } = await capture(message, {
			resolver: resolverServing([[`v=DKIM1; k=rsa; p=${pemToBase64(weak.publicKey)}`]]),
		});

		expect(result).toBe('fail');
		expect(evidence[0]?.verificationVerdict).toBe('fail');
		expect(evidence[0]?.keyBits).toBe(512);
	});

	it('stays silent for a signature that never reached DNS key resolution', async () => {
		// A body-hash mismatch is decided before any key lookup: there is no key
		// record to describe, so no evidence is emitted.
		const tampered = Buffer.concat([sign(), Buffer.from('appended\r\n', 'latin1')]);
		const { result, evidence } = await capture(tampered);

		expect(result).toBe('fail');
		expect(evidence).toEqual([]);
	});

	it('stays silent for an unknown a= — the `none` verdict is never observable', async () => {
		// An unsupported algorithm is skipped (-> none) before the collector is
		// armed, so nothing is emitted. This pins both the unarmed-exit rule and the
		// `Exclude<DkimVerdict, 'none'>` narrowing on `verificationVerdict`.
		const message = Buffer.from(
			sign().toString('latin1').replace('a=rsa-sha256;', 'a=rsa-sha512;'),
			'latin1'
		);
		const { result, evidence } = await capture(message);

		expect(result).toBe('none');
		expect(evidence).toEqual([]);
	});

	it('emits once per signature on a multi-signature message', async () => {
		const signed = sign();
		const doubled = Buffer.concat([
			Buffer.from(`${signatureHeaderOf(signed)}\r\n`, 'latin1'),
			signed,
		]);
		const { result, evidence } = await capture(doubled);

		expect(result).toBe('pass');
		expect(evidence).toHaveLength(2);
		expect(evidence.map((e) => e.verificationVerdict)).toEqual(['pass', 'pass']);
	});

	it('a throwing callback cannot change the verification result', async () => {
		const message = sign();
		let calls = 0;
		const thrown = await verifyDkim(message, {
			resolver,
			onSignatureEvidence: () => {
				calls += 1;
				throw new Error('observer exploded');
			},
		});
		const untapped = await verifyDkim(message, { resolver });

		expect(calls).toBe(1);
		expect(thrown).toEqual(untapped);
		expect(thrown.result).toBe('pass');
	});

	it('omitting the callback leaves the outcome identical', async () => {
		const message = sign();
		const withTap = await verifyDkim(message, { resolver, onSignatureEvidence: () => {} });
		const without = await verifyDkim(message, { resolver });

		expect(withTap).toEqual(without);
	});
});
