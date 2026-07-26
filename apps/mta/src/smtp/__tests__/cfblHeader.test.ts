/**
 * P2-7 (a) — the RFC 9477 `CFBL-Address` header is EMITTED, correctly SIGNED,
 * stays within RFC 5322 line limits, and appears on every outbound stream that
 * should carry it.
 *
 * The real `sendToMx` runs; only the transport/MX/DANE/STS/pool seams are
 * stubbed (the harness shape is copied from `returnPathPerDomain.test.ts`), so
 * the assertions are made against the ACTUAL wire bytes handed to
 * `sendEnvelope`. `bounce/cfblAddress.js` is deliberately NOT mocked — the point
 * is to verify the signature the sender really produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

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
import {
	MAX_HEADER_LINE_OCTETS,
	RECOMMENDED_HEADER_LINE_OCTETS,
	buildCfblHeaders,
	extractCfblAddressFromHeaderValue,
	foldCfblHeaderLine,
	parseCfblAddress,
	parseCfblToken,
} from '../../bounce/cfblAddress.js';
import * as dkimStore from '../dkimStore.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

const SIGNING_KEY = 'cfbl-header-test-key';
const GLOBAL_RETURN_PATH = 'bounces.owlat.com';

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
		from: 'sender@acme.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'acme.com',
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

describe('P2-7 (a) — CFBL-Address header emission', () => {
	let redis: RealRedis;

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
	});

	afterEach(async () => {
		dkimStore.clearCache();
		await redis.flushall();
		vi.clearAllMocks();
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('emits a correctly SIGNED CFBL-Address that verifies back to the send', async () => {
		const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
		expect(result.success).toBe(true);

		const value = headerValue('CFBL-Address');
		expect(value).toBeDefined();
		// RFC 9477 §4.1: address + mandatory report format parameter.
		expect(value).toMatch(/; report=arf$/);

		const address = extractCfblAddressFromHeaderValue(value!);
		expect(address).not.toBeNull();
		expect(address!.endsWith(`@${GLOBAL_RETURN_PATH}`)).toBe(true);
		expect(address!.startsWith('fbl+')).toBe(true);

		// The signature verifies and recovers the exact send it was minted for.
		const parsed = parseCfblAddress(address!, SIGNING_KEY);
		expect(parsed).toEqual({ ok: true, messageId: 'send_abc123' });
	});

	it('emits the signed CFBL-Feedback-ID companion carrying the same token', async () => {
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const token = headerValue('CFBL-Feedback-ID');
		expect(token).toBeDefined();
		expect(parseCfblToken(token!, SIGNING_KEY)).toEqual({ ok: true, messageId: 'send_abc123' });

		// It is the SAME token as the address local-part — one signature, two
		// carriers, so a provider may echo either one.
		const address = extractCfblAddressFromHeaderValue(headerValue('CFBL-Address')!);
		expect(address).toBe(`fbl+${token}@${GLOBAL_RETURN_PATH}`);
	});

	it('rides the per-domain return-path host when one is registered', async () => {
		await dkimStore.setReturnPathHost(redis, 'acme.com', 'bounce.acme.com');
		dkimStore.clearCache();

		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const address = extractCfblAddressFromHeaderValue(headerValue('CFBL-Address')!);
		expect(address!.endsWith('@bounce.acme.com')).toBe(true);
		// Attribution never covers the host, so the token still verifies.
		expect(parseCfblAddress(address!, SIGNING_KEY)).toEqual({
			ok: true,
			messageId: 'send_abc123',
		});
	});

	it.each(['transactional', 'campaign'] as const)(
		'appears on the %s stream (every composed outbound message carries it)',
		async (ipPool) => {
			await sendToMx(createJob({ ipPool }), createConfig(), redis, '10.0.0.1');
			expect(headerLine('CFBL-Address')).toBeDefined();
			expect(headerLine('CFBL-Feedback-ID')).toBeDefined();
		}
	);

	it('coexists with the Gmail Feedback-ID header rather than replacing it', async () => {
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

	it('a caller-supplied CFBL-Address can NEVER displace the signed one', async () => {
		await sendToMx(
			createJob({ headers: { 'CFBL-Address': 'attacker@evil.test; report=arf' } }),
			createConfig(),
			redis,
			'10.0.0.1'
		);

		const lines = wireBytes()
			.split('\r\n')
			.filter((line) => line.toLowerCase().startsWith('cfbl-address:'));
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain('evil.test');
		const address = extractCfblAddressFromHeaderValue(headerValue('CFBL-Address')!);
		expect(parseCfblAddress(address!, SIGNING_KEY).ok).toBe(true);
	});

	it('emits NO header when no signing key is configured (unsigned is worse than absent)', async () => {
		delete process.env['BOUNCE_VERP_KEY'];

		const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		// D2: the absence is silent and non-blocking — the send still succeeds.
		expect(result.success).toBe(true);
		expect(headerLine('CFBL-Address')).toBeUndefined();
		expect(headerLine('CFBL-Feedback-ID')).toBeUndefined();
	});

	it('leaves sealed-mail raw bytes untouched (no header injected into signed MIME)', async () => {
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

	describe('RFC 5322 line geometry', () => {
		it('the rendered header line never crosses the 998-octet hard cap', async () => {
			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			const line = headerLine('CFBL-Address')!;
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(MAX_HEADER_LINE_OCTETS);
			// No bare CR/LF smuggled into the value (header-injection guard).
			expect(line).not.toMatch(/[\r\n]/);
		});

		it('holds the hard cap even for a maximal message id and a long host', async () => {
			const headers = buildCfblHeaders('m'.repeat(200), `${'sub.'.repeat(15)}bounces.example.com`);
			// Over the RFC 5321 320-octet path cap → no header at all rather than a
			// truncated (and therefore unverifiable) address.
			expect(headers).toEqual({});

			const long = buildCfblHeaders('m'.repeat(120), 'bounces.example.com');
			const value = long['CFBL-Address'];
			expect(value).toBeDefined();
			expect(Buffer.byteLength(`CFBL-Address: ${value!}`, 'utf-8')).toBeLessThanOrEqual(
				MAX_HEADER_LINE_OCTETS
			);
		});

		it('folds on the parameter FWS so every physical line honours the 78-octet SHOULD', async () => {
			await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

			const folded = foldCfblHeaderLine('CFBL-Address', headerValue('CFBL-Address')!);
			for (const line of folded) {
				expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(
					RECOMMENDED_HEADER_LINE_OCTETS
				);
			}
			// Unfolding the rendering reproduces the emitted value exactly, so the
			// signature survives a receiver that folds or unfolds the header.
			const unfolded = folded.join('').replace(/^CFBL-Address: /, '');
			expect(extractCfblAddressFromHeaderValue(unfolded)).toBe(
				extractCfblAddressFromHeaderValue(headerValue('CFBL-Address')!)
			);
		});
	});
});
