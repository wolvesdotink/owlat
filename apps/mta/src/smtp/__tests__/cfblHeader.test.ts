/**
 * P2-7 (a) — the RFC 9477 `CFBL-Address` header is EMITTED, correctly SIGNED,
 * covered by the DKIM `h=` tag, stays within RFC 5322 line limits, and appears
 * on every outbound stream that should carry it.
 *
 * The real `sendToMx` runs; only the transport/MX/DANE/STS/pool seams are
 * stubbed (the harness shape is copied from `returnPathPerDomain.test.ts`), so
 * the assertions are made against the ACTUAL wire bytes handed to
 * `sendEnvelope`. `bounce/cfblAddress.js` is deliberately NOT mocked — the point
 * is to verify the signature the sender really produced.
 *
 * Two RFC 9477 conformance rules shape most of what follows:
 *
 *   §3.1.2/§3.1.3 — the CFBL host must be the `RFC5322.From` domain or a child
 *   of it, unless the message carries a SECOND DKIM signature aligned with the
 *   CFBL host. Owlat signs once, so the header is emitted only on the aligned
 *   branch; both branches are pinned below.
 *
 *   §3.1.4 — both CFBL fields MUST appear in the `h=` tag, or "the Mailbox
 *   Provider SHALL NOT send a report message". That is asserted against a real
 *   RSA key with an independent verifier, not against our own signer alone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { dkimVerify } from 'mailauth';

const { connectMock, sendEnvelopeMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendEnvelopeMock: vi.fn(),
}));

vi.mock('@owlat/smtp-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/smtp-client')>();
	return {
		...actual,
		SmtpConnection: { connect: connectMock },
		sendEnvelope: sendEnvelopeMock,
	};
});

vi.mock('../connectionPool.js', () => ({
	pool: {
		acquire: vi.fn().mockReturnValue({ key: 'test-key', config: {} }),
		release: vi.fn(),
		takeConnection: vi.fn().mockResolvedValue(undefined),
		storeConnection: vi.fn(),
		attachConnection: vi.fn().mockReturnValue(true),
		evictConnection: vi.fn(),
	},
	PoolOverCapError: class PoolOverCapError extends Error {},
}));
vi.mock('../mxResolver.js', () => ({
	resolveMxDestination: vi.fn().mockResolvedValue({
		status: 'deliverable',
		source: 'mx',
		hosts: [{ exchange: 'mx1.example.com', priority: 0 }],
	}),
}));
vi.mock('../daneMxResolver.js', () => ({
	resolveDaneMxDestinations: vi.fn().mockResolvedValue({ status: 'not-found' }),
}));
vi.mock('../mtaSts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../mtaSts.js')>();
	return {
		...actual,
		getStsTlsOptions: vi.fn().mockResolvedValue({
			requireTLS: false,
			rejectUnauthorized: false,
			allowedMxHosts: [],
			policyMode: 'none',
		}),
	};
});
vi.mock('../dkim.js', () => ({
	getDkimOptions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../daneResolver.js', () => ({
	lookupTlsaRecords: vi.fn().mockResolvedValue({ status: 'no-tlsa' }),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendToMx } from '../sender.js';
import { getDkimOptions } from '../dkim.js';
import { buildCfblHeaders, parseCfblAddress, parseCfblToken } from '../../bounce/cfblAddress.js';
import { cfblEmissionsTotal } from '../../monitoring/collector.js';
import * as dkimStore from '../dkimStore.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

const SIGNING_KEY = 'cfbl-header-test-key';
const GLOBAL_RETURN_PATH = 'bounces.owlat.com';
/** The From domain of every job below; the aligned CFBL host is a child of it. */
const FROM_DOMAIN = 'acme.com';
const ALIGNED_RETURN_PATH = 'bounce.acme.com';

/** RFC 5322 §2.1.1 hard cap on a physical header line, excluding CRLF. */
const MAX_HEADER_LINE_OCTETS = 998;

function createConfig(): MtaConfig {
	return {
		apiKey: 'test-master-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: GLOBAL_RETURN_PATH,
		outboundTlsMode: 'opportunistic',
		daneMode: 'off',
	} as unknown as MtaConfig;
}

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'send_abc123',
		to: 'user@remote.test',
		from: `sender@${FROM_DOMAIN}`,
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: FROM_DOMAIN,
		...overrides,
	};
}

/** The exact bytes the sender handed to the transport. */
function wireBytes(): string {
	const envelope = sendEnvelopeMock.mock.calls[0]?.[1] as { data: Buffer } | undefined;
	return (envelope?.data ?? Buffer.alloc(0)).toString('utf-8');
}

/** One unfolded header line from the composed message, or undefined. */
function headerLine(name: string): string | undefined {
	const lower = `${name.toLowerCase()}:`;
	return wireBytes()
		.split('\r\n')
		.find((line) => line.toLowerCase().startsWith(lower));
}

function headerValue(name: string): string | undefined {
	const line = headerLine(name);
	return line?.slice(name.length + 2);
}

/**
 * Recover the bare address from a `CFBL-Address` value, ignoring the parameter
 * list. Test-local on purpose: the sender emits the header unfolded and nothing
 * in production re-reads its own header, so this is an assertion helper, not a
 * production duty dressed up as one.
 */
function cfblAddressOf(value: string): string {
	const head = value.split(';', 1)[0] ?? '';
	const flattened = head.replace(/\s+/g, '');
	return flattened.match(/^<(.+)>$/)?.[1] ?? flattened;
}

/**
 * A header value with its RFC 5322 continuation lines joined back together —
 * the DKIM-Signature is folded, so its `h=` tag rarely sits on the first line.
 */
function foldedHeaderValue(name: string): string | undefined {
	const match = new RegExp(`^${name}:([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im').exec(
		`${wireBytes()}\r\n`
	);
	return match?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim();
}

/** Total value of the emission counter for one bounded outcome. */
async function emissionCount(outcome: string): Promise<number> {
	const metric = await cfblEmissionsTotal.get();
	return metric.values
		.filter((value) => value.labels['outcome'] === outcome)
		.reduce((sum, value) => sum + value.value, 0);
}

/** How many CFBL-Address field lines the wire actually carries. */
function cfblAddressLines(): string[] {
	return wireBytes()
		.split('\r\n')
		.filter((line) => line.toLowerCase().startsWith('cfbl-address:'));
}

describe('P2-7 (a) — CFBL-Address header emission', () => {
	let redis: RealRedis;

	/**
	 * Register the per-domain return-path host so the CFBL host aligns with the
	 * From domain (RFC 9477 §3.1.2) — the branch on which the header is emitted.
	 */
	async function alignReturnPath(host = ALIGNED_RETURN_PATH): Promise<void> {
		await dkimStore.setReturnPathHost(redis, FROM_DOMAIN, host);
		dkimStore.clearCache();
	}

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		dkimStore.clearCache();
		connectMock.mockReset();
		connectMock.mockResolvedValue({ secured: true });
		sendEnvelopeMock.mockReset();
		sendEnvelopeMock.mockResolvedValue({
			accepted: [],
			rejected: [],
			response: { code: 250, text: '2.0.0 OK', lines: ['2.0.0 OK'] },
		});
		process.env['BOUNCE_VERP_KEY'] = SIGNING_KEY;
		cfblEmissionsTotal.reset();
		// Unsigned by default; the §3.1.4 block below swaps in a real RSA key.
		vi.mocked(getDkimOptions).mockResolvedValue(undefined);
	});

	afterEach(async () => {
		dkimStore.clearCache();
		await redis.flushall();
		vi.clearAllMocks();
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('emits a correctly SIGNED CFBL-Address that verifies back to the send', async () => {
		await alignReturnPath();

		const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
		expect(result.success).toBe(true);

		const value = headerValue('CFBL-Address');
		expect(value).toBeDefined();
		// RFC 9477 §4.1: address + mandatory report format parameter.
		expect(value).toMatch(/; report=arf$/);

		const address = cfblAddressOf(value!);
		expect(address.endsWith(`@${ALIGNED_RETURN_PATH}`)).toBe(true);
		expect(address.startsWith('fbl+')).toBe(true);

		// The signature verifies and recovers the exact send it was minted for.
		expect(parseCfblAddress(address, SIGNING_KEY)).toEqual({
			ok: true,
			messageId: 'send_abc123',
		});
	});

	it('emits the signed CFBL-Feedback-ID companion carrying the same token', async () => {
		await alignReturnPath();
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const token = headerValue('CFBL-Feedback-ID');
		expect(token).toBeDefined();
		expect(parseCfblToken(token!, SIGNING_KEY)).toEqual({ ok: true, messageId: 'send_abc123' });

		// It is the SAME token as the address local-part — one signature, two
		// carriers, so a provider may echo either one.
		expect(cfblAddressOf(headerValue('CFBL-Address')!)).toBe(`fbl+${token}@${ALIGNED_RETURN_PATH}`);
	});

	describe('RFC 9477 §3.1.2/§3.1.3 — the CFBL host must align with RFC5322.From', () => {
		it('emits on a per-domain return-path host that is a CHILD of the From domain', async () => {
			await alignReturnPath('bounce.acme.com');

			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			const address = cfblAddressOf(headerValue('CFBL-Address')!);
			expect(address.endsWith('@bounce.acme.com')).toBe(true);
			// Attribution never covers the host, so the token still verifies.
			expect(parseCfblAddress(address, SIGNING_KEY)).toEqual({
				ok: true,
				messageId: 'send_abc123',
			});
		});

		it('emits when the return-path host IS the From domain exactly', async () => {
			await alignReturnPath(FROM_DOMAIN);

			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			expect(cfblAddressOf(headerValue('CFBL-Address')!).endsWith(`@${FROM_DOMAIN}`)).toBe(true);
		});

		it('stays SILENT on the shared global host (a third-party domain, §3.1.3)', async () => {
			// No per-domain host registered → fbl+…@bounces.owlat.com while From is
			// @acme.com. Without the second `d=bounces.owlat.com` signature a
			// conforming provider discards the header, so publishing it would be a
			// decorative field producing no complaint signal at all.
			const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			// D2: the absence is silent and non-blocking — the send still succeeds.
			expect(result.success).toBe(true);
			expect(headerLine('CFBL-Address')).toBeUndefined();
			expect(headerLine('CFBL-Feedback-ID')).toBeUndefined();
			// The VERP return path is untouched by the CFBL decision.
			const envelope = sendEnvelopeMock.mock.calls[0]?.[1] as { from: string } | undefined;
			expect(envelope?.from.endsWith(`@${GLOBAL_RETURN_PATH}`)).toBe(true);
		});

		it('is not fooled by a host that merely ENDS WITH the From domain', () => {
			// `bouncenotacme.com` is not a child of `acme.com`; only a dot boundary
			// counts as a subdomain.
			expect(
				buildCfblHeaders({
					messageId: 'send_abc123',
					cfblHost: 'bouncenotacme.com',
					fromDomain: FROM_DOMAIN,
					key: SIGNING_KEY,
				})
			).toEqual({ outcome: 'host_unaligned', headers: {} });
		});

		it('COUNTS the silent branch so an operator can see that CFBL is off, and why', async () => {
			// Silence is the DEFAULT branch — the aligned host is opt-in admin setup
			// — so an uncounted silence is a feature that is invisibly inert. A
			// counter is not an error, a warning or a setup nag (D2): the send below
			// succeeds either way, nothing is surfaced to the operator unless they
			// go looking at /metrics.
			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
			expect(await emissionCount('host_unaligned')).toBe(1);
			expect(await emissionCount('emitted')).toBe(0);

			await alignReturnPath();
			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
			expect(await emissionCount('emitted')).toBe(1);
			expect(await emissionCount('host_unaligned')).toBe(1);
		});

		it('counts a missing signing key distinctly from an unaligned host', async () => {
			await alignReturnPath();
			delete process.env['BOUNCE_VERP_KEY'];

			const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			// An unsigned complaint handle is worse than none, so nothing is emitted
			// — but the reason is distinguishable from the alignment branch, and the
			// send is still delivered.
			expect(result.success).toBe(true);
			expect(headerLine('CFBL-Address')).toBeUndefined();
			expect(await emissionCount('no_key')).toBe(1);
			expect(await emissionCount('host_unaligned')).toBe(0);
		});
	});

	it.each(['transactional', 'campaign'] as const)(
		'appears on the %s stream (every composed outbound message carries it)',
		async (ipPool) => {
			await alignReturnPath();
			await sendToMx(createJob({ ipPool }), createConfig(), redis, '10.0.0.1');
			expect(headerLine('CFBL-Address')).toBeDefined();
			expect(headerLine('CFBL-Feedback-ID')).toBeDefined();
		}
	);

	it('coexists with the Gmail Feedback-ID header rather than replacing it', async () => {
		await alignReturnPath();
		await sendToMx(
			createJob({ headers: { 'Feedback-ID': 'campaign:cmp1:topic:abc12' } }),
			createConfig(),
			redis,
			'10.0.0.1'
		);

		// The two headers answer different questions and must BOTH survive.
		expect(headerValue('Feedback-ID')).toBe('campaign:cmp1:topic:abc12');
		expect(headerValue('CFBL-Feedback-ID')).not.toBe('campaign:cmp1:topic:abc12');
		expect(headerLine('CFBL-Address')).toBeDefined();
	});

	describe('a caller-supplied CFBL field never reaches the wire', () => {
		it.each([
			['exact case', 'CFBL-Address'],
			['lowercase', 'cfbl-address'],
			['mixed case', 'Cfbl-AdDrEsS'],
		])('strips a %s caller key, leaving exactly one signed line', async (_label, key) => {
			await alignReturnPath();
			await sendToMx(
				createJob({ headers: { [key]: 'attacker@evil.test; report=arf' } }),
				createConfig(),
				redis,
				'10.0.0.1'
			);

			// RFC 5322 field names are case-insensitive and RFC 9477 defines no
			// tiebreak between duplicates, so a second line would let a tenant
			// redirect (or void) its own complaint feedback.
			const lines = cfblAddressLines();
			expect(lines).toHaveLength(1);
			expect(lines[0]).not.toContain('evil.test');
			expect(parseCfblAddress(cfblAddressOf(headerValue('CFBL-Address')!), SIGNING_KEY).ok).toBe(
				true
			);
		});

		it('strips a caller CFBL-Feedback-ID too', async () => {
			await alignReturnPath();
			await sendToMx(
				createJob({ headers: { 'cfbl-feedback-id': 'attacker-token' } }),
				createConfig(),
				redis,
				'10.0.0.1'
			);

			expect(wireBytes()).not.toContain('attacker-token');
			expect(parseCfblToken(headerValue('CFBL-Feedback-ID')!, SIGNING_KEY).ok).toBe(true);
		});

		it('strips it even when WE emit nothing (no signing key)', async () => {
			delete process.env['BOUNCE_VERP_KEY'];
			await alignReturnPath();

			const result = await sendToMx(
				createJob({
					headers: {
						'CFBL-Address': 'attacker@evil.test; report=arf',
						'cfbl-feedback-id': 'attacker-token',
					},
				}),
				createConfig(),
				redis,
				'10.0.0.1'
			);

			// An unsigned complaint handle we cannot verify is strictly worse than
			// none, so the strip is unconditional rather than a side effect of
			// overwriting our own pair.
			expect(result.success).toBe(true);
			expect(cfblAddressLines()).toHaveLength(0);
			expect(wireBytes()).not.toContain('evil.test');
			expect(wireBytes()).not.toContain('attacker-token');
		});

		it('leaves every other caller header untouched', async () => {
			await alignReturnPath();
			await sendToMx(
				createJob({ headers: { 'X-Custom': 'kept', 'CFBL-Address': 'a@evil.test' } }),
				createConfig(),
				redis,
				'10.0.0.1'
			);

			expect(headerValue('X-Custom')).toBe('kept');
		});
	});

	it('emits NO header when no signing key is configured (unsigned is worse than absent)', async () => {
		delete process.env['BOUNCE_VERP_KEY'];
		await alignReturnPath();

		const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		// D2: the absence is silent and non-blocking — the send still succeeds.
		expect(result.success).toBe(true);
		expect(headerLine('CFBL-Address')).toBeUndefined();
		expect(headerLine('CFBL-Feedback-ID')).toBeUndefined();
	});

	it('leaves sealed-mail raw bytes untouched (no header injected into signed MIME)', async () => {
		await alignReturnPath();
		const sealed = Buffer.from(
			'From: sender@acme.com\r\nTo: user@remote.test\r\nSubject: Sealed\r\n\r\nbody\r\n',
			'utf-8'
		).toString('base64');

		const result = await sendToMx(
			createJob({ sealedMimeBase64: sealed }),
			createConfig(),
			redis,
			'10.0.0.1'
		);

		expect(result.success).toBe(true);
		expect(wireBytes()).not.toContain('CFBL-Address');
	});

	it('counts a sealed-mail send as sealed_raw, NEVER as emitted', async () => {
		// The return-path host IS aligned here, so the only thing standing between
		// this send and a CFBL pair is the sealed path shipping raw MIME verbatim.
		// Counting it `emitted` would report a header that is provably not on the
		// wire and defeat the question the counter exists to answer.
		await alignReturnPath();
		const sealed = Buffer.from(
			'From: sender@acme.com\r\nTo: user@remote.test\r\nSubject: Sealed\r\n\r\nbody\r\n',
			'utf-8'
		).toString('base64');

		const result = await sendToMx(
			createJob({ sealedMimeBase64: sealed }),
			createConfig(),
			redis,
			'10.0.0.1'
		);

		expect(result.success).toBe(true);
		expect(wireBytes()).not.toContain('CFBL-Address');
		expect(await emissionCount('sealed_raw')).toBe(1);
		expect(await emissionCount('emitted')).toBe(0);
		expect(await emissionCount('host_unaligned')).toBe(0);
	});

	describe('RFC 9477 §3.1.4 — both fields are covered by the DKIM h= tag', () => {
		const SELECTOR = 'cfbl2026';

		/**
		 * Feed the production signing seam a REAL RSA key and serve the matching
		 * public key through an in-memory resolver, so the signature is verified by
		 * an independent implementation rather than by our own signer.
		 */
		function useRealDkimKey(): (name: string, rrtype: string) => Promise<string[][]> {
			const { publicKey, privateKey } = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			});
			vi.mocked(getDkimOptions).mockResolvedValue({
				domainName: FROM_DOMAIN,
				keySelector: SELECTOR,
				privateKey,
			});
			const record = `v=DKIM1; k=rsa; p=${publicKey
				.replace('-----BEGIN PUBLIC KEY-----', '')
				.replace('-----END PUBLIC KEY-----', '')
				.replace(/\s/g, '')}`;
			const expected = `${SELECTOR}._domainkey.${FROM_DOMAIN}`;
			return (name, rrtype) =>
				Promise.resolve(rrtype === 'TXT' && name === expected ? [[record]] : []);
		}

		function signedHeaderList(): string[] {
			const sig = foldedHeaderValue('DKIM-Signature');
			expect(sig).toBeDefined();
			const h = /(?:^|;|\s)h=([^;]+)/.exec(sig!);
			expect(h).not.toBeNull();
			return h![1]!.split(':').map((name) => name.trim().toLowerCase());
		}

		it('lists cfbl-address and cfbl-feedback-id in h=, and the signature verifies', async () => {
			const resolver = useRealDkimKey();
			await alignReturnPath();

			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			// Uncovered, RFC 9477 §3.1.4 says the provider "SHALL NOT send a report
			// message" — the whole feature would be inert.
			const signed = signedHeaderList();
			expect(signed).toContain('cfbl-address');
			expect(signed).toContain('cfbl-feedback-id');

			const result = await dkimVerify(wireBytes(), { resolver });
			const dkim = result.results[0];
			expect(dkim?.status?.result).toBe('pass');
			expect(dkim?.signingDomain).toBe(FROM_DOMAIN);
		});

		it('OVERSIGNS cfbl-address, so an added second instance breaks the signature', async () => {
			const resolver = useRealDkimKey();
			await alignReturnPath();

			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			// Two slots for one instance: the extra one is the RFC 6376 §5.4 null
			// header that a later-prepended CFBL-Address would have to occupy.
			expect(signedHeaderList().filter((name) => name === 'cfbl-address')).toHaveLength(2);

			const tampered = wireBytes().replace(
				/^CFBL-Address:/m,
				'CFBL-Address: attacker@evil.test; report=arf\r\nCFBL-Address:'
			);
			const result = await dkimVerify(tampered, { resolver });
			expect(result.results[0]?.status?.result).not.toBe('pass');
		});
	});

	describe('RFC 5322 line geometry', () => {
		it('the rendered header line never crosses the 998-octet hard cap', async () => {
			await alignReturnPath();
			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			const line = headerLine('CFBL-Address')!;
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(MAX_HEADER_LINE_OCTETS);
			// No bare CR/LF smuggled into the value (header-injection guard).
			expect(line).not.toMatch(/[\r\n]/);
		});

		it('holds the hard cap even for a maximal message id and a long host', () => {
			const longHost = `${'sub.'.repeat(15)}bounces.example.com`;
			const headers = buildCfblHeaders({
				messageId: 'm'.repeat(200),
				cfblHost: longHost,
				fromDomain: longHost,
				key: SIGNING_KEY,
			});
			// Over the RFC 5321 320-octet path cap → no header at all rather than a
			// truncated (and therefore unverifiable) address.
			expect(headers).toEqual({ outcome: 'no_address', headers: {} });

			const long = buildCfblHeaders({
				messageId: 'm'.repeat(120),
				cfblHost: 'bounces.example.com',
				fromDomain: 'bounces.example.com',
				key: SIGNING_KEY,
			});
			const value = long.headers['CFBL-Address'];
			expect(value).toBeDefined();
			expect(Buffer.byteLength(`CFBL-Address: ${value!}`, 'utf-8')).toBeLessThanOrEqual(
				MAX_HEADER_LINE_OCTETS
			);
		});
	});
});
