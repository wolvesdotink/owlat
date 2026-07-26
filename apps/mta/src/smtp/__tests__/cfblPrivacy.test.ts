/**
 * P2-7 (e) — the CFBL header leaks no recipient identity to a passive observer.
 *
 * The `CFBL-Address` value travels in the clear inside every message we send.
 * Anyone who can read one message — the recipient, their mail client, an
 * intermediate relay, anyone who is forwarded the mail — can read the header.
 * It must therefore be a pure attribution handle and nothing else: no recipient
 * address, no recipient hash, no organization id, no campaign name, and no
 * value that lets two messages be correlated to the same person.
 *
 * The check is deliberately made against the ACTUAL composed wire bytes rather
 * than against the builder, so a future change that widens the token is caught
 * where it would actually leak.
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

import { createHash } from 'crypto';
import { sendToMx } from '../sender.js';
import { buildCfblHeaders } from '../../bounce/cfblAddress.js';
import * as dkimStore from '../dkimStore.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

const SIGNING_KEY = 'cfbl-privacy-test-key';
const RECIPIENT = 'alice.example@remote.test';
const ORGANIZATION_ID = 'org_secret_acme';

function createConfig(): MtaConfig {
	return {
		apiKey: 'test-master-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		outboundTlsMode: 'opportunistic',
		daneMode: 'off',
	} as unknown as MtaConfig;
}

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'send_abc123',
		to: RECIPIENT,
		from: 'sender@acme.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'campaign',
		organizationId: ORGANIZATION_ID,
		dkimDomain: 'acme.com',
		...overrides,
	};
}

function cfblHeaderLines(): string[] {
	const envelope = sendEnvelopeMock.mock.calls[0]?.[1] as { data: Buffer } | undefined;
	return (envelope?.data ?? Buffer.alloc(0))
		.toString('utf-8')
		.split('\r\n')
		.filter((line) => line.toLowerCase().startsWith('cfbl-'));
}

describe('P2-7 (e) — CFBL header privacy', () => {
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

	it('carries no recipient address, local-part, or domain — in any encoding', async () => {
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const headers = cfblHeaderLines().join('\n');
		expect(headers).not.toContain(RECIPIENT);
		expect(headers).not.toContain('alice.example');
		expect(headers).not.toContain('remote.test');
		// …nor base64url'd, which is the encoding the token itself uses.
		expect(headers).not.toContain(Buffer.from(RECIPIENT).toString('base64url'));
		expect(headers).not.toContain(Buffer.from('alice.example').toString('base64url'));
	});

	it('carries no recipient HASH — a pseudonym is still an identifier', async () => {
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const headers = cfblHeaderLines().join('\n');
		for (const algorithm of ['md5', 'sha1', 'sha256'] as const) {
			const digest = createHash(algorithm).update(RECIPIENT).digest('hex');
			expect(headers).not.toContain(digest);
			expect(headers).not.toContain(digest.slice(0, 16));
		}
	});

	it('carries no organization id and no campaign id', async () => {
		await sendToMx(
			createJob({ headers: { 'Feedback-ID': 'campaign:cmpjuly000000001:topic:abc12' } }),
			createConfig(),
			redis,
			'10.0.0.1'
		);

		const headers = cfblHeaderLines().join('\n');
		expect(headers).not.toContain(ORGANIZATION_ID);
		expect(headers).not.toContain('cmpjuly000000001');
		expect(headers).not.toContain(Buffer.from(ORGANIZATION_ID).toString('base64url'));
	});

	it('the decoded token is EXACTLY the opaque message id and nothing more', () => {
		const built = buildCfblHeaders('send_abc123', 'bounces.owlat.com', SIGNING_KEY);
		const token = built['CFBL-Feedback-ID']!;
		const encodedId = token.split('+')[0]!;

		expect(Buffer.from(encodedId, 'base64url').toString('utf-8')).toBe('send_abc123');
	});

	it('two recipients of the SAME campaign cannot be correlated through the header', async () => {
		await sendToMx(createJob({ messageId: 'send_one' }), createConfig(), redis, '10.0.0.1');
		const first = cfblHeaderLines().join('\n');

		sendEnvelopeMock.mockClear();
		await sendToMx(
			createJob({ messageId: 'send_two', to: 'bob@remote.test' }),
			createConfig(),
			redis,
			'10.0.0.1'
		);
		const second = cfblHeaderLines().join('\n');

		// Per-message tokens, no shared per-recipient or per-campaign component: a
		// passive observer holding both messages learns only that they are two
		// different sends.
		expect(first).not.toBe(second);
		expect(first).not.toContain('bob@remote.test');
		expect(second).not.toContain(RECIPIENT);
	});

	it('the same message id mints the same token — no hidden nonce that could encode state', () => {
		const now = Date.UTC(2026, 6, 27, 12, 0, 0);
		const a = buildCfblHeaders('send_abc123', 'bounces.owlat.com', SIGNING_KEY, now);
		const b = buildCfblHeaders('send_abc123', 'bounces.owlat.com', SIGNING_KEY, now);
		expect(a).toEqual(b);
	});
});
