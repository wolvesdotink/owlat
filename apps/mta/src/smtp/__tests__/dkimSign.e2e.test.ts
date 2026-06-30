/**
 * DKIM end-to-end signature production + verification (PR-26)
 *
 * The only sender test (sender.test.ts) mocks DKIM out, so no test ever
 * produces a *real* signature and verifies it. That means a regression — a
 * nodemailer bump that changes the `dkim` option shape, or connectionPool
 * dropping `options.dkim` from createTransport — would ship UNSIGNED mail and
 * silently break DMARC at Gmail with zero test failures.
 *
 * This test closes that gap: it drives the production seam
 * (setDkimKey -> getDkimOptions) into a real nodemailer transport, captures the
 * resulting RFC822 message, and verifies the DKIM-Signature with mailauth's
 * dkimVerify against the *generated* public key (served through an in-memory
 * DNS resolver — no network, no fixtures).
 *
 * RFC 6376 §6.1 (Signature Verification).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import nodemailer from 'nodemailer';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { dkimVerify } from 'mailauth';
import { setDkimKey, getDkimConfig, clearCache } from '../dkimStore.js';
import { getDkimOptions, makeDkimProcessFunc } from '../dkim.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DOMAIN = 'example.com';
const SELECTOR = 's2026';

/** Strip PEM armor + whitespace -> the bare base64 a DKIM TXT record carries. */
function publicKeyToDnsRecord(publicKeyPem: string): string {
	const p = publicKeyPem
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');
	return `v=DKIM1; k=rsa; p=${p}`;
}

/**
 * Generate an RSA-2048 keypair, seed the private key into the (mock) Redis store
 * exactly as production does, and return a mailauth-compatible DNS resolver that
 * serves the matching public key TXT record at `<selector>._domainkey.<domain>`.
 */
async function seedKeyAndResolver(redis: RealRedis): Promise<{
	resolver: (name: string, rrtype: string) => Promise<string[][]>;
	dnsRecord: string;
}> {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	await setDkimKey(redis, DOMAIN, SELECTOR, privateKey);

	const dnsRecord = publicKeyToDnsRecord(publicKey);
	const expectedName = `${SELECTOR}._domainkey.${DOMAIN}`;

	const resolver = async (name: string, rrtype: string): Promise<string[][]> => {
		if (rrtype === 'TXT' && name === expectedName) {
			return [[dnsRecord]];
		}
		// Unknown name -> behave like NXDOMAIN (empty answer).
		return [];
	};

	return { resolver, dnsRecord };
}

/**
 * Build a real nodemailer stream transport wired with the PRODUCTION DKIM
 * signer, send a message, and return the raw RFC822 bytes it produced.
 *
 * This drives the exact seam `connectionPool.acquire` uses in production: the
 * resolved key from `getDkimOptions` is fed to our hardened signer through
 * nodemailer's `stream` plugin (`mail.message.processFunc(...)`), NOT through
 * nodemailer's built-in `dkim` transport option (which cannot oversign or emit
 * `t=`). So every assertion below — including the pre-existing PR-26 ones —
 * exercises the real signer.
 */
async function signMessage(
	redis: RealRedis,
	mail: nodemailer.SendMailOptions,
): Promise<string> {
	const dkim = await getDkimOptions(redis, DOMAIN);
	// The production seam MUST hand us a key, otherwise we ship unsigned.
	expect(dkim).toBeDefined();

	const transport = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
		newline: 'windows',
	});

	// Mirror connectionPool.ts: sign via the stream plugin with the hardened signer.
	(transport as unknown as {
		use(
			step: string,
			plugin: (
				m: { message?: { processFunc(fn: (i: NodeJS.ReadableStream) => NodeJS.ReadableStream): void } },
				done: (err?: Error) => void,
			) => void,
		): void;
	}).use('stream', (m, done) => {
		m.message?.processFunc(makeDkimProcessFunc(dkim!));
		done();
	});

	const info = (await transport.sendMail(mail)) as { message: Buffer };
	return info.message.toString('utf8');
}

/** Pull the value of a header out of a folded RFC822 message. */
function extractHeader(rfc822: string, header: string): string | undefined {
	// Match the header, then unfold continuation lines (start with WSP).
	const re = new RegExp(`^${header}:([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im');
	const m = re.exec(rfc822);
	if (!m) return undefined;
	return m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

describe('DKIM end-to-end signing + verification (PR-26)', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		clearCache();
	});

	it('produces a verifiable DKIM-Signature through the production seam', async () => {
		const { resolver } = await seedKeyAndResolver(redis);

		// Sanity: the store round-trips the private key.
		const stored = await getDkimConfig(redis, DOMAIN);
		expect(stored?.selector).toBe(SELECTOR);

		const rfc822 = await signMessage(redis, {
			from: 'a@example.com',
			to: 'recipient@elsewhere.test',
			subject: 'Hello from PR-26',
			text: 'This is the signed body.\nSecond line.\n',
		});

		// 1. A DKIM-Signature header exists at all.
		expect(rfc822).toMatch(/^DKIM-Signature:/im);

		const sig = extractHeader(rfc822, 'DKIM-Signature');
		expect(sig).toBeDefined();
		const sigStr = sig as string;

		// 2. The signature tags are RFC 6376 conformant + DMARC-relevant.
		expect(sigStr).toMatch(/(^|;|\s)v=1(;|\s|$)/); // version
		expect(sigStr).toMatch(/(^|;|\s)a=rsa-sha256(;|\s|$)/); // algorithm
		expect(sigStr).toMatch(/(^|;|\s)c=relaxed\/relaxed(;|\s|$)/); // canonicalization
		expect(sigStr).toMatch(new RegExp(`(^|;|\\s)d=${DOMAIN.replace('.', '\\.')}(;|\\s|$)`));
		expect(sigStr).toMatch(new RegExp(`(^|;|\\s)s=${SELECTOR}(;|\\s|$)`));

		// 3. The signed-headers list (h=) covers the alignment-critical headers.
		const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sigStr);
		expect(hMatch).not.toBeNull();
		const signedHeaders = (hMatch as RegExpExecArray)[1]
			.split(':')
			.map((h) => h.trim().toLowerCase());
		expect(signedHeaders).toContain('from');
		expect(signedHeaders).toContain('subject');

		// 4. The crypto actually verifies against the published public key.
		const result = await dkimVerify(rfc822, { resolver });
		expect(result.results.length).toBeGreaterThan(0);
		const dkimResult = result.results[0]!;
		expect(dkimResult.signingDomain).toBe(DOMAIN);
		expect(dkimResult.selector).toBe(SELECTOR);
		expect(dkimResult.status.result).toBe('pass');
	});

	it('detects tampering: a single body-byte mutation fails verification', async () => {
		const { resolver } = await seedKeyAndResolver(redis);

		const rfc822 = await signMessage(redis, {
			from: 'a@example.com',
			to: 'recipient@elsewhere.test',
			subject: 'Integrity check',
			text: 'original body content\n',
		});
		expect(rfc822).toContain('original body content');

		// Mutate one byte of the body AFTER signing.
		const tampered = rfc822.replace('original body content', 'modified body content');
		expect(tampered).not.toBe(rfc822);

		const result = await dkimVerify(tampered, { resolver });
		expect(result.results[0]!.status.result).not.toBe('pass');
	});

	// PR-26: lock nodemailer's relaxed-body canonicalization edge cases. RFC 6376
	// §3.4.4 relaxed body strips trailing whitespace per line and removes trailing
	// empty lines; a nodemailer regression in that codec would break these. These
	// cover the shapes real transactional/marketing mail actually produces.
	describe('relaxed-body canonicalization edge cases all verify (RFC 6376 §3.4.4)', () => {
		const bodyVariants: Array<{ name: string; text: string }> = [
			{ name: 'empty body', text: '' },
			{ name: 'single newline only', text: '\n' },
			{ name: 'trailing blank lines', text: 'line one\nline two\n\n\n' },
			{ name: 'bare-LF line endings', text: 'alpha\nbeta\ngamma\n' },
			{ name: 'trailing spaces on each line', text: 'has trailing   \nspaces here \t\n' },
			{ name: 'no trailing newline', text: 'body with no terminating newline' },
		];

		for (const variant of bodyVariants) {
			it(`verifies pass for ${variant.name}`, async () => {
				const { resolver } = await seedKeyAndResolver(redis);

				const rfc822 = await signMessage(redis, {
					from: 'a@example.com',
					to: 'recipient@elsewhere.test',
					subject: `body variant: ${variant.name}`,
					text: variant.text,
				});

				expect(rfc822).toMatch(/^DKIM-Signature:/im);

				const result = await dkimVerify(rfc822, { resolver });
				expect(result.results.length).toBeGreaterThan(0);
				expect(result.results[0]!.status.result).toBe('pass');
			});
		}
	});

	/**
	 * Whitespace-only bodies now verify cleanly.
	 *
	 * PR-26 (when the production signer was nodemailer's built-in) documented a
	 * KNOWN DIVERGENCE: for a body that is whitespace with NO real content
	 * (e.g. '   \t  '), nodemailer emitted bh = sha256("\r\n") while mailauth's
	 * verifier canonicalized to the empty string (bh = sha256("")), so the result
	 * was 'neutral' ("body hash did not verify").
	 *
	 * PR-28 replaces the signer with one that body-hashes through mailauth's OWN
	 * relaxed-body canonicalizer — the very codec the verifier uses. Signer and
	 * verifier now agree on the empty-body hash, so these verify 'pass'. This is
	 * a strict improvement (one fewer codec disagreement) and is pinned here so a
	 * future mailauth bump that re-introduces a divergence trips this test.
	 */
	/**
	 * PR-28 — defense-in-depth DKIM hardening: oversigning + `t=` timestamp.
	 *
	 * These FAIL against nodemailer's built-in signer (no oversigning, no `t=`)
	 * and PASS against the hardened signer in `dkim.ts`.
	 */
	describe('PR-28: oversigning From/Subject/To + t= timestamp', () => {
		/** Unfold + extract the DKIM-Signature header into a single-line string. */
		function dkimSigOf(rfc822: string): string {
			const sig = extractHeader(rfc822, 'DKIM-Signature');
			expect(sig).toBeDefined();
			return sig as string;
		}

		/** Parse the colon-delimited `h=` list into lowercased header names. */
		function signedHeaderList(sigStr: string): string[] {
			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sigStr);
			expect(hMatch).not.toBeNull();
			return (hMatch as RegExpExecArray)[1].split(':').map((h) => h.trim().toLowerCase());
		}

		it('oversigns From, Subject and To (each appears >= 2 times in h=)', async () => {
			await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, {
				from: 'a@example.com',
				to: 'recipient@elsewhere.test',
				subject: 'Oversign me',
				text: 'body\n',
			});

			const list = signedHeaderList(dkimSigOf(rfc822));
			const count = (name: string) => list.filter((h) => h === name).length;

			// RFC 6376 §8.15 / M3AAWG oversigning: listing a header MORE times than
			// it occurs makes any added instance break the signature.
			expect(count('from')).toBeGreaterThanOrEqual(2);
			expect(count('subject')).toBeGreaterThanOrEqual(2);
			expect(count('to')).toBeGreaterThanOrEqual(2);
		});

		it('detects a second prepended From injected AFTER signing (oversigning closes the replay/forgery gap)', async () => {
			const { resolver } = await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, {
				from: 'a@example.com',
				to: 'recipient@elsewhere.test',
				subject: 'Original',
				text: 'legitimate body\n',
			});

			// Baseline: the untampered message verifies.
			const ok = await dkimVerify(rfc822, { resolver });
			expect(ok.results[0]!.status.result).toBe('pass');

			// Attacker prepends a SECOND From header (the one a DMARC-aware verifier
			// and many MUAs will actually evaluate / display) without touching the
			// signed bytes. Because From is oversigned, the From count no longer
			// matches what was signed, so verification FAILS — exactly the gap a
			// single-signed (non-oversigned) From would silently let through.
			const tampered = 'From: attacker@evil.test\r\n' + rfc822;
			expect(tampered).not.toBe(rfc822);

			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		it('stamps t= within a few seconds of now, with no x= (or x= > t=)', async () => {
			await seedKeyAndResolver(redis);

			const before = Math.floor(Date.now() / 1000);
			const rfc822 = await signMessage(redis, {
				from: 'a@example.com',
				to: 'recipient@elsewhere.test',
				subject: 'Timestamped',
				text: 'body\n',
			});
			const after = Math.floor(Date.now() / 1000);

			const sigStr = dkimSigOf(rfc822);

			// RFC 6376 §3.5: t= is the signature creation time (seconds since epoch).
			const tMatch = /(?:^|;|\s)t=(\d+)(?:;|\s|$)/.exec(sigStr);
			expect(tMatch).not.toBeNull();
			const t = Number((tMatch as RegExpExecArray)[1]);

			// Within a few seconds of "now" on either side of the send.
			expect(t).toBeGreaterThanOrEqual(before - 5);
			expect(t).toBeLessThanOrEqual(after + 5);

			// x= (expiry) is either absent (preferred for an outbound MTA) or, if a
			// future bump adds one, must be strictly after t= (RFC 6376 §3.5).
			const xMatch = /(?:^|;|\s)x=(\d+)(?:;|\s|$)/.exec(sigStr);
			if (xMatch) {
				expect(Number(xMatch[1])).toBeGreaterThan(t);
			}
		});

		it('a hardened-signer signature still verifies pass end-to-end', async () => {
			const { resolver } = await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, {
				from: 'a@example.com',
				to: 'recipient@elsewhere.test',
				subject: 'Hardened but valid',
				text: 'multi\nline\nbody\n',
			});

			const result = await dkimVerify(rfc822, { resolver });
			expect(result.results.length).toBeGreaterThan(0);
			expect(result.results[0]!.signingDomain).toBe(DOMAIN);
			expect(result.results[0]!.selector).toBe(SELECTOR);
			expect(result.results[0]!.status.result).toBe('pass');
		});
	});

	describe('whitespace-only body now verifies (PR-28: shared mailauth codec)', () => {
		const whitespaceOnlyVariants: Array<{ name: string; text: string }> = [
			{ name: 'spaces and tabs, no newline', text: '   \t  ' },
			{ name: 'spaces then a newline', text: '   \n' },
		];

		for (const variant of whitespaceOnlyVariants) {
			it(`signs and verifies pass for ${variant.name}`, async () => {
				const { resolver } = await seedKeyAndResolver(redis);

				const rfc822 = await signMessage(redis, {
					from: 'a@example.com',
					to: 'recipient@elsewhere.test',
					subject: `whitespace variant: ${variant.name}`,
					text: variant.text,
				});

				expect(rfc822).toMatch(/^DKIM-Signature:/im);

				const result = await dkimVerify(rfc822, { resolver });
				expect(result.results.length).toBeGreaterThan(0);
				expect(result.results[0]!.status.result).toBe('pass');
			});
		}
	});

	/**
	 * PR-27 — Regression-lock the DKIM *signing invariants* on top of the PR-26
	 * harness. PR-26 proved the chain produces *a* verifiable signature; PR-27
	 * pins the specific properties that DMARC at Gmail/Yahoo depends on, so a
	 * nodemailer/mailauth bump that silently changed any of them trips here.
	 *
	 * RFC 6376 §3.5 (tags), §3.7 (header hashing over final headers), §3.4
	 * (relaxed canonicalization), §5.4 (h= must include From). RFC 8301 (sha1
	 * MUST NOT be used). RFC 7489 §3.1.1 (DKIM identifier alignment for DMARC).
	 */
	describe('PR-27 signing invariants', () => {
		const standardMail = (overrides?: Partial<nodemailer.SendMailOptions>): nodemailer.SendMailOptions => ({
			from: 'a@example.com',
			to: 'recipient@elsewhere.test',
			subject: 'Original subject',
			date: new Date('2026-06-21T12:00:00Z'),
			messageId: '<pr27-invariant@example.com>',
			text: 'A body with real content.\nSecond line.\n',
			...overrides,
		});

		// (1) Signing is post-mutation: the signature commits to the FINAL header
		// bytes, so mutating a signed header after the fact must fail verification.
		// RFC 6376 §3.7.
		it('signs the final headers: mutating Subject after signing fails verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signMessage(redis, standardMail());

			// Baseline: untouched message verifies pass.
			const ok = await dkimVerify(rfc822, { resolver });
			expect(ok.results[0]!.status.result).toBe('pass');

			// Subject is in h= (see below), so rewriting it post-signing breaks the
			// header hash.
			expect(rfc822).toContain('Subject: Original subject');
			const tampered = rfc822.replace('Subject: Original subject', 'Subject: Tampered subject');
			expect(tampered).not.toBe(rfc822);

			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		// (2) Algorithm + canonicalization are literally relaxed/relaxed +
		// rsa-sha256, and NEVER the deprecated rsa-sha1. RFC 8301 forbids sha1;
		// relaxed/relaxed survives the whitespace/folding rewrites intermediaries
		// apply. RFC 6376 §3.5.
		it('uses c=relaxed/relaxed and a=rsa-sha256, never rsa-sha1', async () => {
			await seedKeyAndResolver(redis);
			const rfc822 = await signMessage(redis, standardMail());
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;
			expect(sig).toBeDefined();

			expect(sig).toContain('c=relaxed/relaxed');
			expect(sig).toContain('a=rsa-sha256');
			// RFC 8301: sha1 MUST NOT appear anywhere in the algorithm tag.
			expect(sig).not.toMatch(/rsa-sha1/i);
			expect(sig).not.toMatch(/a=\S*sha1/i);
		});

		// (3) No l= (body-length) tag: a present l= lets an attacker append bytes
		// past the signed length and still verify. Its ABSENCE means bh covers the
		// WHOLE body, so appending any byte must fail. RFC 6376 §3.5 (l= tag) /
		// §8.2 (the appendix attack).
		it('emits no l= body-length tag, so appending body bytes fails verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signMessage(redis, standardMail({ text: 'signed body region.\n' }));
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;

			// The literal regex from the audit: no l= tag may be present.
			expect(sig).not.toMatch(/(^|;)\s*l=/);

			// Baseline pass, then append bytes after the signed body.
			expect((await dkimVerify(rfc822, { resolver })).results[0]!.status.result).toBe('pass');

			// Append content to the very end of the message body (after the last
			// signed byte). With no l= cap the body hash covers it -> must fail.
			const appended = `${rfc822}appended-trailing-bytes-not-covered\r\n`;
			const result = await dkimVerify(appended, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		// (4) h= covers the From (mandatory for alignment) plus the other
		// identity-bearing headers when present: subject, date, to, message-id.
		// RFC 6376 §5.4 (From MUST be signed); §3.7 lists recommended headers.
		it('signs from + subject + date + to + message-id when present', async () => {
			await seedKeyAndResolver(redis);
			const rfc822 = await signMessage(redis, standardMail());
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;

			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sig);
			expect(hMatch).not.toBeNull();
			const signedHeaders = hMatch![1]!
				.split(':')
				.map((h) => h.trim().toLowerCase())
				.filter(Boolean);

			expect(signedHeaders).toContain('from'); // RFC 6376 §5.4 — mandatory
			expect(signedHeaders).toContain('subject');
			expect(signedHeaders).toContain('date');
			expect(signedHeaders).toContain('to');
			expect(signedHeaders).toContain('message-id');
		});
	});

	/**
	 * PR-16 — both List-Unsubscribe AND List-Unsubscribe-Post must be in the DKIM
	 * h= tag.
	 *
	 * RFC 8058 §5.2 / Gmail's 2024 bulk-sender rules: the one-click unsubscribe
	 * button is only rendered when BOTH headers are covered by a DKIM signature
	 * whose d= aligns with From. nodemailer's built-in DKIM signer (its
	 * `defaultFieldNames`) signs `List-Unsubscribe` but NOT `List-Unsubscribe-Post`
	 * and has no oversign/field-list override, so if the production signer ever fell
	 * back to it, the POST directive would ship UNSIGNED and Gmail would suppress
	 * the button. The hardened signer in `dkim.ts` lists both in `SIGNED_HEADERS`;
	 * this pins that so a regression (or a revert to the nodemailer default set)
	 * trips here.
	 *
	 * It drives the real production seam: a job whose headers carry the one-click
	 * pair (exactly as `delivery/unsubscribe.ts` + the campaign composer assemble
	 * them) is composed by a real nodemailer transport, signed by the hardened
	 * signer, and the resulting DKIM-Signature h= tag is parsed and asserted to
	 * contain BOTH names (case-insensitive). The signature must also still verify
	 * end-to-end so the headers are genuinely integrity-protected, not just listed.
	 */
	describe('PR-16: List-Unsubscribe + List-Unsubscribe-Post are both DKIM-signed (RFC 8058 §5.2)', () => {
		const ONE_CLICK_MAIL: nodemailer.SendMailOptions = {
			from: 'a@example.com',
			to: 'recipient@elsewhere.test',
			subject: 'Weekly digest',
			text: 'Newsletter body.\nUnsubscribe via the header.\n',
			headers: {
				'List-Unsubscribe':
					'<https://example.com/unsub/contact-123:1700000000000:sigabc>',
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			},
		};

		it('lists BOTH list-unsubscribe and list-unsubscribe-post in the h= tag', async () => {
			await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, ONE_CLICK_MAIL);

			// Sanity: both headers actually made it onto the wire.
			expect(extractHeader(rfc822, 'List-Unsubscribe')).toBeDefined();
			expect(extractHeader(rfc822, 'List-Unsubscribe-Post')).toBe(
				'List-Unsubscribe=One-Click',
			);

			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;
			expect(sig).toBeDefined();

			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sig);
			expect(hMatch).not.toBeNull();
			const signedHeaders = (hMatch as RegExpExecArray)[1]
				.split(':')
				.map((h) => h.trim().toLowerCase());

			// The crux of RFC 8058 §5.2 + Gmail 2024: the POST directive is only
			// trusted (button rendered) when it is covered by the signature.
			expect(signedHeaders).toContain('list-unsubscribe');
			expect(signedHeaders).toContain('list-unsubscribe-post');
		});

		it('a one-click-unsubscribe message still verifies pass end-to-end', async () => {
			const { resolver } = await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, ONE_CLICK_MAIL);

			const result = await dkimVerify(rfc822, { resolver });
			expect(result.results.length).toBeGreaterThan(0);
			expect(result.results[0]!.status.result).toBe('pass');
		});

		it('mutating the signed List-Unsubscribe-Post after signing breaks verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);

			const rfc822 = await signMessage(redis, ONE_CLICK_MAIL);
			// Baseline: untouched message verifies.
			expect((await dkimVerify(rfc822, { resolver })).results[0]!.status.result).toBe(
				'pass',
			);

			// Because List-Unsubscribe-Post is in h=, rewriting it after signing must
			// fail the header hash — proving it is genuinely integrity-protected.
			expect(rfc822).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
			const tampered = rfc822.replace(
				'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
				'List-Unsubscribe-Post: List-Unsubscribe=Forged',
			);
			expect(tampered).not.toBe(rfc822);

			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});
	});
});
