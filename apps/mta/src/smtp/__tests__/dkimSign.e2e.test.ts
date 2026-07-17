/**
 * DKIM end-to-end signature production + verification (PR-26 / outbound cutover)
 *
 * The only sender test (sender.test.ts) mocks DKIM out, so this test closes the
 * gap: it drives the PRODUCTION signing seam — `getDkimOptions` (key management,
 * apps/mta/src/smtp/dkim.ts) feeding `@owlat/mail-message`'s
 * `composeMessage` + `signMessage(raw, key)` — captures the resulting RFC822
 * bytes, and verifies the DKIM-Signature with mailauth's `dkimVerify` against the
 * generated public key (served through an in-memory DNS resolver — no network).
 *
 * It covers BOTH outbound payload shapes the sender signs:
 *   - the STRUCTURED compose path (`composeMessage` → `signMessage`), and
 *   - the RAW sealed-mail path (`signMessage` over provided sealed MIME bytes).
 *
 * The four oracles (here: mailauth) stay as devDependencies — our signer is never
 * verified by itself alone. RFC 6376 §6.1 (Signature Verification).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { dkimVerify } from 'mailauth';
import {
	composeMessage,
	signMessage,
	type ComposeMessageInput,
	type DkimSigningKey,
} from '@owlat/mail-message';
import { setDkimKey, getDkimConfig, clearCache } from '../dkimStore.js';
import { getDkimOptions } from '../dkim.js';

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
		return [];
	};

	return { resolver };
}

/**
 * Drive the PRODUCTION structured-compose seam: resolve the key via
 * `getDkimOptions`, compose via `composeMessage`, sign via `signMessage`. Returns
 * the signed RFC822 bytes as a string.
 */
async function signStructured(redis: RealRedis, input: ComposeMessageInput): Promise<string> {
	const dkim = await getDkimOptions(redis, DOMAIN);
	// The production seam MUST hand us a key, otherwise we ship unsigned.
	expect(dkim).toBeDefined();
	const composed = composeMessage(input);
	return signMessage(composed.raw, dkim as DkimSigningKey).toString('utf8');
}

/** Pull the value of a header out of a folded RFC822 message. */
function extractHeader(rfc822: string, header: string): string | undefined {
	const re = new RegExp(`^${header}:([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im');
	const m = re.exec(rfc822);
	if (!m) return undefined;
	return m[1]!.replace(/\r?\n[ \t]+/g, ' ').trim();
}

describe('DKIM end-to-end signing + verification (outbound cutover)', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		clearCache();
	});

	it('produces a verifiable DKIM-Signature through the production seam', async () => {
		const { resolver } = await seedKeyAndResolver(redis);

		const stored = await getDkimConfig(redis, DOMAIN);
		expect(stored?.selector).toBe(SELECTOR);

		const rfc822 = await signStructured(redis, {
			from: 'a@example.com',
			to: ['recipient@elsewhere.test'],
			subject: 'Hello from the cutover',
			text: 'This is the signed body.\nSecond line.\n',
		});

		expect(rfc822).toMatch(/^DKIM-Signature:/im);

		const sig = extractHeader(rfc822, 'DKIM-Signature');
		expect(sig).toBeDefined();
		const sigStr = sig as string;

		expect(sigStr).toMatch(/(^|;|\s)v=1(;|\s|$)/);
		expect(sigStr).toMatch(/(^|;|\s)a=rsa-sha256(;|\s|$)/);
		expect(sigStr).toMatch(/(^|;|\s)c=relaxed\/relaxed(;|\s|$)/);
		expect(sigStr).toMatch(new RegExp(`(^|;|\\s)d=${DOMAIN.replace('.', '\\.')}(;|\\s|$)`));
		expect(sigStr).toMatch(new RegExp(`(^|;|\\s)s=${SELECTOR}(;|\\s|$)`));

		const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sigStr);
		expect(hMatch).not.toBeNull();
		const signedHeaders = (hMatch as RegExpExecArray)[1]!
			.split(':')
			.map((h) => h.trim().toLowerCase());
		expect(signedHeaders).toContain('from');
		expect(signedHeaders).toContain('subject');

		const result = await dkimVerify(rfc822, { resolver });
		expect(result.results.length).toBeGreaterThan(0);
		const dkimResult = result.results[0]!;
		expect(dkimResult.signingDomain).toBe(DOMAIN);
		expect(dkimResult.selector).toBe(SELECTOR);
		expect(dkimResult.status.result).toBe('pass');
	});

	it('detects tampering: a single body-byte mutation fails verification', async () => {
		const { resolver } = await seedKeyAndResolver(redis);

		const rfc822 = await signStructured(redis, {
			from: 'a@example.com',
			to: ['recipient@elsewhere.test'],
			subject: 'Integrity check',
			text: 'original body content\n',
		});
		expect(rfc822).toContain('original body content');

		const tampered = rfc822.replace('original body content', 'modified body content');
		expect(tampered).not.toBe(rfc822);

		const result = await dkimVerify(tampered, { resolver });
		expect(result.results[0]!.status.result).not.toBe('pass');
	});

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

				const rfc822 = await signStructured(redis, {
					from: 'a@example.com',
					to: ['recipient@elsewhere.test'],
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

	describe('oversigning From/Subject/To + t= timestamp', () => {
		function dkimSigOf(rfc822: string): string {
			const sig = extractHeader(rfc822, 'DKIM-Signature');
			expect(sig).toBeDefined();
			return sig as string;
		}
		function signedHeaderList(sigStr: string): string[] {
			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sigStr);
			expect(hMatch).not.toBeNull();
			return (hMatch as RegExpExecArray)[1]!.split(':').map((h) => h.trim().toLowerCase());
		}

		it('oversigns From, Subject and To (each appears >= 2 times in h=)', async () => {
			await seedKeyAndResolver(redis);

			const rfc822 = await signStructured(redis, {
				from: 'a@example.com',
				to: ['recipient@elsewhere.test'],
				subject: 'Oversign me',
				text: 'body\n',
			});

			const list = signedHeaderList(dkimSigOf(rfc822));
			const count = (name: string) => list.filter((h) => h === name).length;
			expect(count('from')).toBeGreaterThanOrEqual(2);
			expect(count('subject')).toBeGreaterThanOrEqual(2);
			expect(count('to')).toBeGreaterThanOrEqual(2);
		});

		it('detects a second prepended From injected AFTER signing (oversigning closes the replay/forgery gap)', async () => {
			const { resolver } = await seedKeyAndResolver(redis);

			const rfc822 = await signStructured(redis, {
				from: 'a@example.com',
				to: ['recipient@elsewhere.test'],
				subject: 'Original',
				text: 'legitimate body\n',
			});

			const ok = await dkimVerify(rfc822, { resolver });
			expect(ok.results[0]!.status.result).toBe('pass');

			const tampered = 'From: attacker@evil.test\r\n' + rfc822;
			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		it('stamps t= within a few seconds of now, with no x= (or x= > t=)', async () => {
			await seedKeyAndResolver(redis);

			const before = Math.floor(Date.now() / 1000);
			const rfc822 = await signStructured(redis, {
				from: 'a@example.com',
				to: ['recipient@elsewhere.test'],
				subject: 'Timestamped',
				text: 'body\n',
			});
			const after = Math.floor(Date.now() / 1000);

			const sigStr = dkimSigOf(rfc822);
			const tMatch = /(?:^|;|\s)t=(\d+)(?:;|\s|$)/.exec(sigStr);
			expect(tMatch).not.toBeNull();
			const t = Number((tMatch as RegExpExecArray)[1]);
			expect(t).toBeGreaterThanOrEqual(before - 5);
			expect(t).toBeLessThanOrEqual(after + 5);

			const xMatch = /(?:^|;|\s)x=(\d+)(?:;|\s|$)/.exec(sigStr);
			if (xMatch) {
				expect(Number(xMatch[1])).toBeGreaterThan(t);
			}
		});
	});

	/**
	 * Whitespace-only bodies now verify cleanly (pinned PR-28 improvement).
	 *
	 * When the production signer was nodemailer's built-in codec, a body that was
	 * whitespace with NO real content (e.g. '   \t  ') diverged: nodemailer emitted
	 * bh = sha256("\r\n") while mailauth's verifier canonicalized to the empty
	 * string (bh = sha256("")), so verification came back 'neutral' ("body hash did
	 * not verify"). The in-house signer body-hashes through the ONE mail-auth
	 * relaxed-body canon (U4) — the very codec the verifier uses — so signer and
	 * verifier agree and these verify 'pass'. Pinned so a future canon change that
	 * re-introduces the divergence trips here. Signed on the composeMessage/
	 * signMessage seam (the production structured path), not a library internal.
	 */
	describe('whitespace-only body now verifies (PR-28: shared mail-auth codec)', () => {
		const whitespaceOnlyVariants: Array<{ name: string; text: string }> = [
			{ name: 'spaces and tabs, no newline', text: '   \t  ' },
			{ name: 'spaces then a newline', text: '   \n' },
		];

		for (const variant of whitespaceOnlyVariants) {
			it(`signs and verifies pass for ${variant.name}`, async () => {
				const { resolver } = await seedKeyAndResolver(redis);

				const rfc822 = await signStructured(redis, {
					from: 'a@example.com',
					to: ['recipient@elsewhere.test'],
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

	describe('signing invariants (RFC 6376 / 8301 / 8058)', () => {
		const standardInput = (overrides?: Partial<ComposeMessageInput>): ComposeMessageInput => ({
			from: 'a@example.com',
			to: ['recipient@elsewhere.test'],
			subject: 'Original subject',
			date: new Date('2026-06-21T12:00:00Z'),
			messageId: '<pr27-invariant@example.com>',
			text: 'A body with real content.\nSecond line.\n',
			...overrides,
		});

		it('signs the final headers: mutating Subject after signing fails verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, standardInput());

			const ok = await dkimVerify(rfc822, { resolver });
			expect(ok.results[0]!.status.result).toBe('pass');

			expect(rfc822).toContain('Subject: Original subject');
			const tampered = rfc822.replace('Subject: Original subject', 'Subject: Tampered subject');
			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		it('uses c=relaxed/relaxed and a=rsa-sha256, never rsa-sha1', async () => {
			await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, standardInput());
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;
			expect(sig).toContain('c=relaxed/relaxed');
			expect(sig).toContain('a=rsa-sha256');
			expect(sig).not.toMatch(/rsa-sha1/i);
			expect(sig).not.toMatch(/a=\S*sha1/i);
		});

		it('emits no l= body-length tag, so appending body bytes fails verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, standardInput({ text: 'signed body region.\n' }));
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;
			expect(sig).not.toMatch(/(^|;)\s*l=/);

			expect((await dkimVerify(rfc822, { resolver })).results[0]!.status.result).toBe('pass');

			const appended = `${rfc822}appended-trailing-bytes-not-covered\r\n`;
			const result = await dkimVerify(appended, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});

		it('signs from + subject + date + to + message-id when present', async () => {
			await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, standardInput());
			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;

			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sig);
			expect(hMatch).not.toBeNull();
			const signedHeaders = hMatch![1]!
				.split(':')
				.map((h) => h.trim().toLowerCase())
				.filter(Boolean);

			expect(signedHeaders).toContain('from');
			expect(signedHeaders).toContain('subject');
			expect(signedHeaders).toContain('date');
			expect(signedHeaders).toContain('to');
			expect(signedHeaders).toContain('message-id');
		});
	});

	describe('List-Unsubscribe + List-Unsubscribe-Post are both DKIM-signed (RFC 8058 §5.2)', () => {
		const oneClickInput = (): ComposeMessageInput => ({
			from: 'a@example.com',
			to: ['recipient@elsewhere.test'],
			subject: 'Weekly digest',
			text: 'Newsletter body.\nUnsubscribe via the header.\n',
			headers: {
				'List-Unsubscribe': '<https://example.com/unsub/contact-123:1700000000000:sigabc>',
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			},
		});

		it('lists BOTH list-unsubscribe and list-unsubscribe-post in the h= tag', async () => {
			await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, oneClickInput());

			expect(extractHeader(rfc822, 'List-Unsubscribe')).toBeDefined();
			expect(extractHeader(rfc822, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');

			const sig = extractHeader(rfc822, 'DKIM-Signature') as string;
			const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sig);
			expect(hMatch).not.toBeNull();
			const signedHeaders = (hMatch as RegExpExecArray)[1]!
				.split(':')
				.map((h) => h.trim().toLowerCase());
			expect(signedHeaders).toContain('list-unsubscribe');
			expect(signedHeaders).toContain('list-unsubscribe-post');
		});

		it('a one-click-unsubscribe message still verifies pass end-to-end', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, oneClickInput());
			const result = await dkimVerify(rfc822, { resolver });
			expect(result.results.length).toBeGreaterThan(0);
			expect(result.results[0]!.status.result).toBe('pass');
		});

		it('mutating the signed List-Unsubscribe-Post after signing breaks verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const rfc822 = await signStructured(redis, oneClickInput());
			expect((await dkimVerify(rfc822, { resolver })).results[0]!.status.result).toBe('pass');

			expect(rfc822).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
			const tampered = rfc822.replace(
				'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
				'List-Unsubscribe-Post: List-Unsubscribe=Forged'
			);
			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});
	});

	// ── The RAW sealed-mail path: signMessage over provided sealed MIME bytes ──
	// The sender signs sealed Postbox PGP/MIME as EXACT bytes (no re-composition).
	// The resulting DKIM-Signature must still verify pass under mailauth, proving
	// the sealed path is DMARC-safe just like the structured-compose path.
	describe('raw sealed-mail path', () => {
		function sealedMime(): Buffer {
			return Buffer.from(
				'From: a@example.com\r\n' +
					'To: recipient@elsewhere.test\r\n' +
					'Subject: sealed\r\n' +
					'MIME-Version: 1.0\r\n' +
					'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="pgpb"\r\n' +
					'\r\n' +
					'--pgpb\r\n' +
					'Content-Type: application/pgp-encrypted\r\n\r\n' +
					'Version: 1\r\n' +
					'--pgpb\r\n' +
					'Content-Type: application/octet-stream\r\n\r\n' +
					'-----BEGIN PGP MESSAGE-----\r\nciphertextbytes\r\n-----END PGP MESSAGE-----\r\n' +
					'--pgpb--\r\n'
			);
		}

		it('signs sealed MIME bytes verbatim and the signature verifies pass under mailauth', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const dkim = await getDkimOptions(redis, DOMAIN);
			expect(dkim).toBeDefined();

			const sealed = sealedMime();
			const signed = signMessage(sealed, dkim as DkimSigningKey);
			// The original sealed bytes are preserved verbatim after the prepended sig.
			expect(signed.subarray(signed.length - sealed.length)).toEqual(sealed);

			const rfc822 = signed.toString('utf8');
			expect(rfc822).toMatch(/^DKIM-Signature:/im);

			const result = await dkimVerify(rfc822, { resolver });
			expect(result.results.length).toBeGreaterThan(0);
			expect(result.results[0]!.signingDomain).toBe(DOMAIN);
			expect(result.results[0]!.status.result).toBe('pass');
		});

		it('mutating the sealed ciphertext after signing fails verification', async () => {
			const { resolver } = await seedKeyAndResolver(redis);
			const dkim = await getDkimOptions(redis, DOMAIN);
			const rfc822 = signMessage(sealedMime(), dkim as DkimSigningKey).toString('utf8');
			expect((await dkimVerify(rfc822, { resolver })).results[0]!.status.result).toBe('pass');

			const tampered = rfc822.replace('ciphertextbytes', 'tamperedbytes!!');
			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]!.status.result).not.toBe('pass');
		});
	});
});
