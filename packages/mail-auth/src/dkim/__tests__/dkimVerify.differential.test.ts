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
 * signed-by-the-oracle pass, SIGNED-BY-US pass (a signature minted over our own
 * public `canon` API, fed to BOTH verifiers — this is the card's "signed-by-us"
 * differential surface, and the class of fixture that pins Blocking 1),
 * oversigned `h=` (the standard header-addition defense — a repeated `h=` name
 * with no second header must be SKIPPED, not synthesized), mutated body, wrong
 * published key, absent key, revoked key, multi-signature strongest-wins, and
 * refolded signed headers.
 *
 * The `l=` -> neutral divergence has its own dedicated test and is not exercised
 * here. The rsa-sha1 policy-fail divergence IS pinned here (crypto-valid
 * rsa-sha1: mailauth `pass`, ours `fail`) so the equality claim documents
 * exactly where and why the two sides differ.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { canonicalizeBodyRelaxed, canonicalizeHeaderField } from '../../canon.js';
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

/**
 * Mint an rsa signature over OUR public `canon` API (relaxed/relaxed), building
 * the header hash input exactly as the verifier does — including the oversigning
 * rule that a repeated `h=` name with no remaining header contributes NOTHING.
 * Returns the raw message with the DKIM-Signature header prepended. Feeding this
 * to BOTH verifiers proves signer/verifier agreement AND that our canon matches
 * mailauth's (byte-identity), so both must reach the same verdict.
 */
function mintOverOurCanon(opts: {
	readonly headers: readonly string[];
	readonly hTag: string;
	readonly body: string;
	readonly hashAlg: 'sha256' | 'sha1';
	readonly algTag: 'rsa-sha256' | 'rsa-sha1';
}): Buffer {
	const canonBody = canonicalizeBodyRelaxed(Buffer.from(opts.body, 'latin1'));
	const bh = createHash(opts.hashAlg).update(canonBody).digest('base64');
	const sigUnsigned =
		`DKIM-Signature: v=1; a=${opts.algTag}; c=relaxed/relaxed; d=${DOMAIN}; s=${SELECTOR};` +
		` h=${opts.hTag}; bh=${bh}; b=`;

	// Bottom-up per-name stacks, consumed exactly as buildHeaderHashInput does.
	const stacks = new Map<string, string[]>();
	for (const h of opts.headers) {
		const name = h.slice(0, h.indexOf(':')).trim().toLowerCase();
		const stack = stacks.get(name);
		if (stack) {
			stack.push(h);
		} else {
			stacks.set(name, [h]);
		}
	}
	const names = opts.hTag
		.split(':')
		.map((n) => n.trim().toLowerCase())
		.filter((n) => n !== '');
	const parts: string[] = [];
	for (const name of names) {
		const raw = stacks.get(name)?.pop();
		if (raw === undefined) {
			continue;
		}
		parts.push(`${canonicalizeHeaderField(raw, 'relaxed')}\r\n`);
	}
	const headerInput = Buffer.from(
		parts.join('') + canonicalizeHeaderField(sigUnsigned, 'relaxed'),
		'latin1'
	);
	const b = createSign(opts.hashAlg).update(headerInput).sign(rsa.privateKey, 'base64');
	const message = `${opts.headers.join('\r\n')}\r\n\r\n${opts.body}`;
	return Buffer.from(`${sigUnsigned}${b}\r\n${message}`, 'latin1');
}

const MINT_HEADERS = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: signed-by-us fixture',
];
const MINT_BODY = 'Body signed with our own canon.\r\n';

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

	it('signed-by-us (our canon) -> pass on BOTH verifiers', async () => {
		const msg = mintOverOurCanon({
			headers: MINT_HEADERS,
			hTag: 'from:to:subject',
			body: MINT_BODY,
			hashAlg: 'sha256',
			algTag: 'rsa-sha256',
		});
		await assertAgree(msg, resolverFor(rsaTxt), 'pass');
	});

	it('oversigned h= (h=from:to:subject:from, one From) -> pass on BOTH', async () => {
		// The standard header-addition defense: `from` is listed a second time to
		// bind against a later-added From, but only one From exists. mailauth and
		// OpenDKIM contribute NOTHING for the extra name; synthesizing `from:`+CRLF
		// would false-`fail` this legitimate, extremely common shape (Blocking 1).
		const msg = mintOverOurCanon({
			headers: MINT_HEADERS,
			hTag: 'from:to:subject:from',
			body: MINT_BODY,
			hashAlg: 'sha256',
			algTag: 'rsa-sha256',
		});
		await assertAgree(msg, resolverFor(rsaTxt), 'pass');
	});

	it('crypto-valid rsa-sha1 -> mailauth pass, ours fail (RFC 8301 policy divergence)', async () => {
		// The one algorithm divergence: rsa-sha1 verifies cryptographically but is
		// policy-failed as deprecated. mailauth still returns `pass`; we return
		// `fail`. Pin BOTH sides so the sanctioned divergence is enumerated (D2).
		const msg = mintOverOurCanon({
			headers: MINT_HEADERS,
			hTag: 'from:to:subject',
			body: MINT_BODY,
			hashAlg: 'sha1',
			algTag: 'rsa-sha1',
		});
		const ours = await verifyDkim(msg, { resolver: resolverFor(rsaTxt) });
		const oracle = normalizeMailauth(await dkimVerify(msg, { resolver: resolverFor(rsaTxt) }));
		expect(oracle).toBe('pass');
		expect(ours.result).toBe('fail');
	});
});
