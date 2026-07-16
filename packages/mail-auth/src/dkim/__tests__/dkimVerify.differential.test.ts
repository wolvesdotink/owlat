/**
 * DKIM verifier — VERDICT EQUALITY vs the `mailauth` oracle (D1: mailauth is
 * kept as a devDependency so these differential tests are not self-referential).
 *
 * For every fixture we sign with `mailauth`'s `dkimSign`, publish the matching
 * key through a mocked TXT resolver, and assert that OUR `verifyDkim` and
 * `mailauth`'s `dkimVerify` (reduced to the same RFC 8601 vocabulary the
 * production `inboundDkim.pickVerdict` uses) reach the SAME message verdict.
 *
 * Covered: rsa-sha256 + ed25519-sha256, simple/simple + relaxed/relaxed,
 * signed-by-the-oracle pass, mutated body, wrong published key, absent key,
 * revoked key, multi-signature strongest-wins, and refolded signed headers.
 *
 * The two SANCTIONED divergences (l= -> neutral, rsa-sha1 policy-fail) are NOT
 * exercised here — they have their own dedicated tests — so strict equality
 * holds across this corpus.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { verifyDkim } from '../verify.js';

type Verdict = 'pass' | 'fail' | 'neutral' | 'none' | 'temperror' | 'permerror';

/** Broad resolver shape accepted by BOTH our verifier and the mailauth oracle. */
type DnsFn = (name: string, rrtype: string) => Promise<string[][]>;

const RANK: Record<Verdict, number> = {
	pass: 6,
	fail: 5,
	permerror: 4,
	temperror: 3,
	neutral: 2,
	none: 1,
};

/** Reduce a mailauth verify result to one verdict — mirrors inboundDkim. */
function normalizeMailauth(result: unknown): Verdict {
	const results = ((result as { results?: unknown[] } | undefined)?.results ?? []) as Array<{
		status?: { result?: string; comment?: string };
	}>;
	if (results.length === 0) {
		return 'none';
	}
	let best: Verdict = 'none';
	for (const sig of results) {
		const raw = (sig.status?.result ?? '').toLowerCase();
		const comment = (sig.status?.comment ?? '').toLowerCase();
		let v: Verdict;
		switch (raw) {
			case 'pass':
				v = 'pass';
				break;
			case 'fail':
				v = 'fail';
				break;
			case 'temperror':
			case 'temperr':
				v = 'temperror';
				break;
			case 'permerror':
				v = 'permerror';
				break;
			case 'neutral':
				if (comment.includes('body hash')) {
					v = 'fail';
				} else if (
					comment.includes('no key') ||
					comment.includes('invalid public key') ||
					comment.includes('missing key') ||
					comment.includes('unknown key') ||
					comment.includes('revoked')
				) {
					v = 'permerror';
				} else {
					v = 'neutral';
				}
				break;
			case 'none':
			case 'skipped':
			case '':
				v = 'none';
				break;
			default:
				v = 'neutral';
		}
		if (RANK[v] > RANK[best]) {
			best = v;
		}
	}
	return best;
}

const DOMAIN = 'example.com';
const SELECTOR = 'sel';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

const RAW_MESSAGE = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: DKIM differential fixture',
	'Date: Tue, 17 Jun 2026 12:00:00 +0000',
	'Message-ID: <fixture-1@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hello from a DKIM-signed message body.',
	'',
].join('\r\n');

/** Extract the base64 SPKI body from a PEM public key. */
function pemToBase64(pem: string): string {
	return pem
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replace(/\s+/g, '');
}

/** Raw 32-byte Ed25519 public key (base64) from a Node key object. */
function ed25519RawBase64(publicKey: KeyObject): string {
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	return spki.subarray(spki.length - 32).toString('base64');
}

/** A resolver serving a fixed TXT record for the DKIM selector only. */
function resolverFor(record: string | null): DnsFn {
	return async (name: string, rrtype: string) => {
		if (rrtype === 'TXT' && name === KEY_NAME && record !== null) {
			return [[record]];
		}
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	};
}

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const rsaTxt = `v=DKIM1; k=rsa; p=${pemToBase64(rsa.publicKey)}`;

const ed = generateKeyPairSync('ed25519');
const edPrivatePem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const edTxt = `v=DKIM1; k=ed25519; p=${ed25519RawBase64(ed.publicKey)}`;

async function signRsa(canon: string, message = RAW_MESSAGE): Promise<Buffer> {
	const res = await dkimSign(Buffer.from(message), {
		canonicalization: canon,
		algorithm: 'rsa-sha256',
		signatureData: [{ signingDomain: DOMAIN, selector: SELECTOR, privateKey: rsa.privateKey }],
	});
	return Buffer.from(res.signatures + message);
}

async function signEd25519(message = RAW_MESSAGE): Promise<Buffer> {
	const res = await dkimSign(Buffer.from(message), {
		canonicalization: 'relaxed/relaxed',
		algorithm: 'ed25519-sha256',
		signatureData: [{ signingDomain: DOMAIN, selector: SELECTOR, privateKey: edPrivatePem }],
	});
	return Buffer.from(res.signatures + message);
}

/** Assert our verdict equals mailauth's normalized verdict. */
async function assertAgree(message: Buffer, resolver: DnsFn, expected: Verdict): Promise<void> {
	const ours = await verifyDkim(message, { resolver });
	const oracle = normalizeMailauth(await dkimVerify(message, { resolver }));
	expect(oracle).toBe(expected);
	expect(ours.result).toBe(expected);
}

describe('verifyDkim differential vs mailauth', () => {
	it('rsa-sha256 relaxed/relaxed, valid -> pass', async () => {
		await assertAgree(await signRsa('relaxed/relaxed'), resolverFor(rsaTxt), 'pass');
	});

	it('rsa-sha256 simple/simple, valid -> pass', async () => {
		await assertAgree(await signRsa('simple/simple'), resolverFor(rsaTxt), 'pass');
	});

	it('rsa-sha256 relaxed/simple, valid -> pass', async () => {
		await assertAgree(await signRsa('relaxed/simple'), resolverFor(rsaTxt), 'pass');
	});

	it('ed25519-sha256, valid -> pass', async () => {
		await assertAgree(await signEd25519(), resolverFor(edTxt), 'pass');
	});

	it('mutated body -> fail (body hash mismatch)', async () => {
		const signed = await signRsa('relaxed/relaxed');
		const mutated = Buffer.from(signed);
		for (let i = mutated.length - 1; i >= 0; i--) {
			const c = mutated[i]!;
			if (c >= 0x61 && c <= 0x7a) {
				mutated[i] = c === 0x7a ? 0x61 : c + 1;
				break;
			}
		}
		await assertAgree(mutated, resolverFor(rsaTxt), 'fail');
	});

	it('absent key (NXDOMAIN) -> permerror', async () => {
		await assertAgree(await signRsa('relaxed/relaxed'), resolverFor(null), 'permerror');
	});

	it('wrong published key -> fail (signature mismatch)', async () => {
		const other = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const wrongTxt = `v=DKIM1; k=rsa; p=${pemToBase64(other.publicKey)}`;
		await assertAgree(await signRsa('relaxed/relaxed'), resolverFor(wrongTxt), 'fail');
	});

	it('refolded signed header still verifies under relaxed -> pass', async () => {
		// Sign, then re-fold the Subject header (transport-style) — relaxed
		// header canonicalization unfolds it, so the verdict is unchanged.
		const signed = (await signRsa('relaxed/relaxed')).toString('latin1');
		const refolded = signed.replace(
			'Subject: DKIM differential fixture',
			'Subject: DKIM differential\r\n fixture'
		);
		await assertAgree(Buffer.from(refolded, 'latin1'), resolverFor(rsaTxt), 'pass');
	});

	it('multi-signature: one good + one bad -> pass (strongest wins)', async () => {
		// Sign once (valid). Prepend a second bogus DKIM-Signature whose body
		// hash cannot match, so mailauth and we both fall back to the good one.
		const good = (await signRsa('relaxed/relaxed')).toString('latin1');
		const bogus =
			`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${DOMAIN}; s=${SELECTOR};\r\n` +
			' h=from:to:subject; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=;\r\n' +
			' b=AAAA\r\n';
		await assertAgree(Buffer.from(bogus + good, 'latin1'), resolverFor(rsaTxt), 'pass');
	});

	it('revoked key (empty p=) -> permerror, and never a pass for either', async () => {
		const revokedTxt = 'v=DKIM1; k=rsa; p=';
		const signed = await signRsa('relaxed/relaxed');
		const ours = await verifyDkim(signed, { resolver: resolverFor(revokedTxt) });
		const oracle = normalizeMailauth(
			await dkimVerify(signed, { resolver: resolverFor(revokedTxt) })
		);
		expect(ours.result).toBe('permerror');
		// A revoked key must never authenticate the message, on either side.
		expect(ours.result).not.toBe('pass');
		expect(oracle).not.toBe('pass');
		expect(oracle).not.toBe('none');
	});
});
