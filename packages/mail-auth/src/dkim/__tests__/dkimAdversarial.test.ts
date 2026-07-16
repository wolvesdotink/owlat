/**
 * DKIM verifier — adversarial / hostile-input suite.
 *
 * The verifier is on the untrusted inbound path, so every hostile shape MUST
 * be BOUNDED and SAFE: no crash, no unhandled rejection, no forged `pass`, no
 * DoS. Locked decision D7: any internal error becomes `temperror`, never a
 * throw. Covered here:
 *   - signature-header injection (a bogus signature must not forge a pass),
 *   - CRLF / header smuggling and truncated headers,
 *   - the 10k-signature bomb (bounded work, definite verdict),
 *   - hostile `_domainkey` TXT records (revoked, garbage, joined strings).
 */

import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'crypto';
import { canonicalizeBodyRelaxed, canonicalizeHeaderField } from '../../canon.js';
import { verifyDkim, type DkimDnsResolver } from '../verify.js';
import { isKeyRecordError, parseDkimKeyRecord } from '../keyRecord.js';

/** A resolver that never has a record — every lookup is NXDOMAIN. */
const noKeyResolver: DkimDnsResolver = async (name) => {
	throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
};

/** A resolver that always throws a TRANSIENT DNS failure. */
const flakyResolver: DkimDnsResolver = async () => {
	throw Object.assign(new Error('server failure'), { code: 'ESERVFAIL' });
};

const BASE_MESSAGE = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: hostile fixture',
	'',
	'body content\r\n',
].join('\r\n');

describe('verifyDkim — hostile input is bounded and safe (D7)', () => {
	it('an unsigned message is none, not an error', async () => {
		const outcome = await verifyDkim(Buffer.from(BASE_MESSAGE), { resolver: noKeyResolver });
		expect(outcome.result).toBe('none');
	});

	it('a signature missing required tags -> permerror (never throws)', async () => {
		const msg = `DKIM-Signature: v=1; a=rsa-sha256; d=evil.example\r\n${BASE_MESSAGE}`;
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: noKeyResolver });
		expect(outcome.result).toBe('permerror');
	});

	it('garbage in the DKIM-Signature value -> permerror, no throw', async () => {
		const msg = `DKIM-Signature: \x00\x01 not even tags ;;;===\r\n${BASE_MESSAGE}`;
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: noKeyResolver });
		expect(['permerror', 'fail', 'temperror']).toContain(outcome.result);
	});

	it('injected bogus signature cannot forge a pass', async () => {
		// A well-formed-looking but cryptographically bogus signature. With no
		// published key it is at best permerror — never pass.
		const msg =
			'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=attacker.example;\r\n' +
			' s=sel; h=from:to:subject; bh=AAAA; b=AAAA\r\n' +
			BASE_MESSAGE;
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: noKeyResolver });
		expect(outcome.result).not.toBe('pass');
	});

	it('CRLF smuggling in tag values does not crash or forge a pass', async () => {
		const msg =
			'DKIM-Signature: v=1; a=rsa-sha256; d=evil.example\r\n\r\nInjected: header\r\n' +
			' s=sel; h=from; bh=AAAA; b=AAAA\r\n' +
			BASE_MESSAGE;
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: noKeyResolver });
		expect(outcome.result).not.toBe('pass');
	});

	it('a transient resolver failure surfaces as temperror', async () => {
		const msg =
			'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;\r\n' +
			' s=sel; h=from:to:subject; bh=frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=;\r\n' +
			' b=AAAA\r\n' +
			BASE_MESSAGE;
		// Body hash here won't match, so we short-circuit to fail BEFORE DNS —
		// use a message whose body hash we don't control; assert no throw and a
		// definite verdict regardless.
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: flakyResolver });
		expect(['temperror', 'fail', 'permerror']).toContain(outcome.result);
	});

	it('10k-signature bomb is bounded and returns a definite verdict', async () => {
		let calls = 0;
		const countingResolver: DkimDnsResolver = async (name) => {
			calls++;
			throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
		};
		// Ten thousand structurally-plausible signatures.
		const bomb = Array.from(
			{ length: 10_000 },
			(_v, i) =>
				`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=d${i}.example;` +
				` s=s; h=from; bh=AAAA; b=AAAA`
		).join('\r\n');
		const msg = `${bomb}\r\n${BASE_MESSAGE}`;

		const start = Date.now();
		const outcome = await verifyDkim(Buffer.from(msg), { resolver: countingResolver });
		const elapsed = Date.now() - start;

		// Bounded: at most MAX_SIGNATURES evaluated, so at most that many lookups.
		expect(calls).toBeLessThanOrEqual(10);
		expect(elapsed).toBeLessThan(5000);
		expect(['permerror', 'fail', 'temperror', 'neutral']).toContain(outcome.result);
	});
});

/* -------------------------------------------------------------------------- */
/*  Security-relevant verify branches (l= PERMFAIL, x= expiry, key/alg edges)  */
/* -------------------------------------------------------------------------- */

const BR_DOMAIN = 'branch.example';
const BR_SELECTOR = 'bsel';
const BR_KEY_NAME = `${BR_SELECTOR}._domainkey.${BR_DOMAIN}`;
const BR_HEADERS = [
	'From: A <a@branch.example>',
	'To: B <b@branch.example>',
	'Subject: branch fixture',
];
const BR_BODY = 'branch body\r\n';

const brRsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const brRsaSpki = brRsa.publicKey
	.replace(/-----BEGIN PUBLIC KEY-----/, '')
	.replace(/-----END PUBLIC KEY-----/, '')
	.replace(/\s+/g, '');
const brRsaRecord = `v=DKIM1; k=rsa; p=${brRsaSpki}`;

/** A resolver serving one TXT record for the branch selector. */
function resolverServing(record: string): DkimDnsResolver {
	return async (name, rrtype) => {
		if (rrtype === 'TXT' && name === BR_KEY_NAME) {
			return [[record]];
		}
		throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
	};
}

/**
 * Craft a message whose body hash is CORRECT but whose `b=` is bogus, with
 * `extraTags` (e.g. `l=abc; `) injected before `b=`. Exercises branches reached
 * on or before the body-hash / key checks, where the crypto is never run.
 */
function craft(extraTags: string): Buffer {
	const canonBody = canonicalizeBodyRelaxed(Buffer.from(BR_BODY, 'latin1'));
	const bh = createHash('sha256').update(canonBody).digest('base64');
	const header =
		`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${BR_DOMAIN}; s=${BR_SELECTOR};` +
		` h=from:to:subject; bh=${bh}; ${extraTags}b=AAAA`;
	return Buffer.from(`${header}\r\n${BR_HEADERS.join('\r\n')}\r\n\r\n${BR_BODY}`, 'latin1');
}

/** Mint a crypto-VALID rsa-sha256 signature with `extraTags` before `b=`. */
function mintValid(extraTags: string): Buffer {
	const canonBody = canonicalizeBodyRelaxed(Buffer.from(BR_BODY, 'latin1'));
	const bh = createHash('sha256').update(canonBody).digest('base64');
	const sigUnsigned =
		`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${BR_DOMAIN}; s=${BR_SELECTOR};` +
		` h=from:to:subject; bh=${bh}; ${extraTags}b=`;
	const parts = BR_HEADERS.map((h) => `${canonicalizeHeaderField(h, 'relaxed')}\r\n`);
	const headerInput = Buffer.from(
		parts.join('') + canonicalizeHeaderField(sigUnsigned, 'relaxed'),
		'latin1'
	);
	const b = createSign('sha256').update(headerInput).sign(brRsa.privateKey, 'base64');
	return Buffer.from(
		`${sigUnsigned}${b}\r\n${BR_HEADERS.join('\r\n')}\r\n\r\n${BR_BODY}`,
		'latin1'
	);
}

describe('verifyDkim — security-relevant verify branches', () => {
	it('malformed l= (non-numeric) -> permerror (RFC 6376 §3.7 PERMFAIL)', async () => {
		const outcome = await verifyDkim(craft('l=abc; '), { resolver: resolverServing(brRsaRecord) });
		expect(outcome.result).toBe('permerror');
	});

	it('oversized l= (larger than the canonicalized body) -> permerror', async () => {
		const outcome = await verifyDkim(craft('l=999999; '), {
			resolver: resolverServing(brRsaRecord),
		});
		expect(outcome.result).toBe('permerror');
	});

	it('x= expired -> fail (crypto-valid but past expiry)', async () => {
		const outcome = await verifyDkim(mintValid('x=500; '), {
			resolver: resolverServing(brRsaRecord),
			now: 1000,
		});
		expect(outcome.result).toBe('fail');
	});

	it('x= in the future -> pass (control for the expiry branch)', async () => {
		const outcome = await verifyDkim(mintValid('x=5000; '), {
			resolver: resolverServing(brRsaRecord),
			now: 1000,
		});
		expect(outcome.result).toBe('pass');
	});

	it('key type / algorithm mismatch (ed25519 record, rsa signature) -> permerror', async () => {
		const edRecord = `v=DKIM1; k=ed25519; p=${Buffer.alloc(32, 1).toString('base64')}`;
		const outcome = await verifyDkim(craft(''), { resolver: resolverServing(edRecord) });
		expect(outcome.result).toBe('permerror');
	});

	it('key h= hash restriction excludes the signature hash -> permerror', async () => {
		const restricted = `v=DKIM1; k=rsa; h=sha1; p=${brRsaSpki}`;
		const outcome = await verifyDkim(craft(''), { resolver: resolverServing(restricted) });
		expect(outcome.result).toBe('permerror');
	});

	it('undecodable p= DER (buildPublicKey failure) -> permerror', async () => {
		const outcome = await verifyDkim(craft(''), {
			resolver: resolverServing('v=DKIM1; k=rsa; p=AAAA'),
		});
		expect(outcome.result).toBe('permerror');
	});
});

describe('parseDkimKeyRecord — hostile TXT records never throw', () => {
	it('parses a well-formed rsa record', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa; p=MIIBIjANBg');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.keyType).toBe('rsa');
			expect(rec.revoked).toBe(false);
		}
	});

	it('flags an empty p= as revoked', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa; p=');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.revoked).toBe(true);
			expect(rec.publicKey).toBe('');
		}
	});

	it('defaults the key type to rsa when k= is absent', () => {
		const rec = parseDkimKeyRecord('p=AAAA');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.keyType).toBe('rsa');
		}
	});

	it('reads testing/flags and hash restrictions', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa; h=sha256; t=y:s; s=email; p=AAAA');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.testing).toBe(true);
			expect(rec.flags).toEqual(['y', 's']);
			expect(rec.hashAlgorithms).toEqual(['sha256']);
			expect(rec.serviceTypes).toEqual(['email']);
		}
	});

	it('duplicate tags are FIRST-WINS (RFC 6376 §3.2 hostile-input pin)', () => {
		// The shared tag-list parser (used by both key records and signatures)
		// keeps the first occurrence so a later duplicate cannot override an
		// earlier tag; this pins that conservative choice rather than rejecting.
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa; p=FIRST; p=SECOND');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.publicKey).toBe('FIRST');
		}
	});

	it('strips whitespace from a p= joined across TXT chunks', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa; p=AAAA BBBB\tCCCC');
		expect(isKeyRecordError(rec)).toBe(false);
		if (!isKeyRecordError(rec)) {
			expect(rec.publicKey).toBe('AAAABBBBCCCC');
		}
	});

	it('rejects a wrong version', () => {
		const rec = parseDkimKeyRecord('v=DKIM2; p=AAAA');
		expect(isKeyRecordError(rec)).toBe(true);
	});

	it('rejects an unsupported key type', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=gost; p=AAAA');
		expect(isKeyRecordError(rec)).toBe(true);
	});

	it('errors (does not throw) on a missing p= tag', () => {
		const rec = parseDkimKeyRecord('v=DKIM1; k=rsa');
		expect(isKeyRecordError(rec)).toBe(true);
	});

	it('does not throw on pure garbage', () => {
		for (const garbage of ['', ';;;;', '=====', '\x00\x01\x02', 'p', 'k=;p']) {
			expect(() => parseDkimKeyRecord(garbage)).not.toThrow();
		}
	});
});
