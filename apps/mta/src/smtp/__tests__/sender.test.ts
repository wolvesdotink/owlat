import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hostname as osHostname } from 'node:os';
import Redis from 'ioredis-mock';

// The outbound path now drives @owlat/smtp-client: sendToMx acquires a connect
// config from the pool, opens ONE SmtpConnection per attempt, sends the
// pre-composed+signed bytes, and classifies on the structured SmtpError. These
// unit tests mock the client's connect/sendEnvelope/quit seam and the pool, and
// inspect the REAL composed bytes (@owlat/mail-message) handed to sendEnvelope.
const { connectMock, sendEnvelopeMock, quitMock, acquireMock, releaseMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendEnvelopeMock: vi.fn(),
	quitMock: vi.fn(),
	acquireMock: vi.fn(),
	releaseMock: vi.fn(),
}));

vi.mock('@owlat/smtp-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/smtp-client')>();
	return {
		...actual,
		SmtpConnection: { connect: connectMock },
		sendEnvelope: sendEnvelopeMock,
		quit: quitMock,
	};
});

vi.mock('../connectionPool.js', () => ({
	pool: { acquire: acquireMock, release: releaseMock },
	PoolOverCapError: class PoolOverCapError extends Error {
		constructor(public readonly mxHost: string) {
			super('cap');
			this.name = 'PoolOverCapError';
		}
	},
}));
vi.mock('../mxResolver.js', () => ({
	getMxHostnames: vi.fn().mockResolvedValue(['mx1.example.com', 'mx2.example.com']),
}));
vi.mock('../daneMxResolver.js', () => ({
	resolveDaneMxDestinations: vi.fn(),
}));
// Only the MTA-STS policy lookup is stubbed (per-test policy mode); `isMxAllowed`
// keeps its real RFC 8461 §4.1 wildcard/empty-list semantics so the enforce skip
// path is exercised honestly. tlsRpt.js is intentionally NOT mocked: the sender's
// `recordTlsResult` writes to the (mock) Redis and the tests read the result back
// via `generateReport`, so the policy-context + STS-specific result types it
// emits are exercised end-to-end.
vi.mock('../mtaSts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../mtaSts.js')>();
	return {
		...actual,
		getStsTlsOptions: vi.fn(),
	};
});
vi.mock('../dkim.js', () => ({
	getDkimOptions: vi.fn().mockResolvedValue(undefined),
}));
// DANE TLSA resolver is stubbed per-test (default: no TLSA, so the DANE branch is
// inert and the historic path is byte-identical).
vi.mock('../daneResolver.js', () => ({
	lookupTlsaRecords: vi.fn().mockResolvedValue({ status: 'no-tlsa' }),
}));
vi.mock('../../bounce/verp.js', () => ({
	buildVerpAddress: vi.fn().mockReturnValue('bounce+encoded@bounces.owlat.com'),
}));
vi.mock('../../queue/groups.js', () => ({
	extractDomain: vi.fn().mockReturnValue('example.com'),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SmtpError, type SmtpErrorInit } from '@owlat/smtp-client';
import { sendToMx } from '../sender.js';
import { getStsTlsOptions } from '../mtaSts.js';
import { getMxHostnames } from '../mxResolver.js';
import { generateReport } from '../tlsRpt.js';
import { lookupTlsaRecords } from '../daneResolver.js';
import { resolveDaneMxDestinations } from '../daneMxResolver.js';
import { logger } from '../../monitoring/logger.js';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { MX_CERT } from './certFixture.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

// A fresh live-connection stub whose `secured` flag the test controls.
function liveConn(secured = true): { secured: boolean; close: ReturnType<typeof vi.fn> } {
	return { secured, close: vi.fn() };
}

/** A real SmtpReply-shaped final response for a successful send. */
function okReply(text = '2.0.0 OK'): { code: number; text: string; lines: string[] } {
	return { code: 250, text, lines: [text] };
}

/** A structured SmtpError, exactly as the client throws. */
function smtpError(init: SmtpErrorInit): SmtpError {
	return new SmtpError(init);
}

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-001',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		...overrides,
	};
}

function createConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		port: 3100,
		bouncePort: 25,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		convexSiteUrl: 'https://test.convex.site',
		webhookSecret: 'secret',
		ipPools: { transactional: ['10.0.0.1'], campaign: ['10.0.0.2'] },
		dkimKeys: {},
		workerConcurrency: 50,
		serverId: 'test-server',
		smtpPool: { maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 },
		orgLimits: { defaultDailyLimit: 50000, defaultHourlyLimit: 5000 },
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
		bounceMaxConnectionsPerIp: 10,
		bounceMaxClients: 200,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 5000,
		inboundSpfEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		...overrides,
	} as MtaConfig;
}

describe('sendToMx', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createConfig();

		vi.mocked(getMxHostnames).mockResolvedValue(['mx1.example.com', 'mx2.example.com']);
		vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
			status: 'destinations',
			destinations: [
				{
					mxHostname: 'mx1.example.com',
					preference: 10,
					mxSecurity: 'secure',
					addressSecurity: 'secure',
					addresses: ['192.0.2.1'],
				},
				{
					mxHostname: 'mx2.example.com',
					preference: 20,
					mxSecurity: 'secure',
					addressSecurity: 'secure',
					addresses: ['192.0.2.2'],
				},
			],
		});
		vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });
		// Default acquire echoes the resolved connect config so assertions can read
		// it back; no live socket is ever opened.
		acquireMock.mockImplementation(
			(
				mxHost: string,
				bindIp: string,
				options: { name?: string; requireTLS?: boolean; tls?: unknown }
			) => ({
				key: `${mxHost}:${bindIp}`,
				config: {
					host: mxHost,
					port: 25,
					ehloName: options.name,
					tlsMode: 'starttls',
					requireTls: options.requireTLS ?? false,
					localAddress: bindIp,
					tls: options.tls,
				},
			})
		);
		// Default happy path: secured connection, accepted send, clean quit.
		connectMock.mockResolvedValue(liveConn(true));
		sendEnvelopeMock.mockResolvedValue({ accepted: [], rejected: [], response: okReply() });
		quitMock.mockResolvedValue(undefined);
		vi.mocked(getStsTlsOptions).mockResolvedValue({
			requireTLS: false,
			rejectUnauthorized: false,
			allowedMxHosts: [],
			policyMode: 'none',
		});
	});

	// ── seam-inspection helpers ──
	/** The raw wire bytes handed to sendEnvelope on the given attempt. */
	function rawOf(call = 0): string {
		const options = sendEnvelopeMock.mock.calls[call]?.[1] as { data: Buffer } | undefined;
		if (!options) throw new Error(`sendEnvelope was not called ${call + 1} time(s)`);
		return options.data.toString('utf8');
	}
	function headerBlockOf(call = 0): string {
		return rawOf(call).split('\r\n\r\n')[0]!;
	}
	function headerValueOf(call: number, name: string): string | undefined {
		const re = new RegExp(`^${name}:([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im');
		const m = re.exec(rawOf(call) + '\r\n');
		return m ? m[1]!.replace(/\r?\n[ \t]+/g, ' ').trim() : undefined;
	}
	/** The acquire options (3rd arg) for a given acquire call. */
	function acquireOpts(call = 0): {
		name?: string;
		requireTLS?: boolean;
		tls?: {
			rejectUnauthorized?: boolean;
			minVersion?: string;
			verifyPeerCertificate?: (s: TLSSocket) => Error | undefined;
			danePolicyFingerprint?: string;
			checkServerIdentity?: unknown;
		};
	} {
		return acquireMock.mock.calls[call]![2];
	}

	it('returns hard bounce when no MX records found', async () => {
		vi.mocked(getMxHostnames).mockResolvedValue([]);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
	});

	it('returns success with remoteMessageId parsed from response', async () => {
		sendEnvelopeMock.mockResolvedValue({
			accepted: [],
			rejected: [],
			response: okReply('2.0.0 OK <remote-id@mx.example.com>'),
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(result.smtpCode).toBe(250);
		expect(result.remoteMessageId).toBe('remote-id@mx.example.com');
	});

	it('returns hard bounce on 5xx SMTP error and stops trying', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({ phase: 'rcpt', message: '550 5.1.1 User unknown', replyCode: 550, secured: true })
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
		// A 5xx is a permanent verdict on the recipient — never retry the next MX.
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
	});

	it('returns soft bounce for 5.2.2 (mailbox full) despite 5xx code', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({
				phase: 'rcpt',
				message: '552 5.2.2 Mailbox full',
				replyCode: 552,
				enhancedCode: '5.2.2',
				secured: true,
			})
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(result.smtpCode).toBe(552);
		expect(result.enhancedCode).toBe('5.2.2');
	});

	it('returns deferred on 4xx SMTP error', async () => {
		sendEnvelopeMock.mockRejectedValue(
			smtpError({ phase: 'mail', message: '451 4.7.1 Try later', replyCode: 451, secured: true })
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('deferred');
		expect(result.smtpCode).toBe(451);
	});

	it('tries next MX host on connection error', async () => {
		// A reply-less, tls-less connect failure is a connection-level error.
		connectMock
			.mockRejectedValueOnce(
				smtpError({ phase: 'connect', message: 'ECONNREFUSED', secured: false })
			)
			.mockResolvedValue(liveConn(true));

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(connectMock).toHaveBeenCalledTimes(2); // tried both MX
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1); // only the second delivered
	});

	it('returns soft bounce when all MX hosts fail with connection errors', async () => {
		connectMock.mockRejectedValue(
			smtpError({ phase: 'connect', message: 'ECONNREFUSED', secured: false })
		);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(connectMock).toHaveBeenCalledTimes(2);
	});

	it('forwards an AMP body to the composer as a text/x-amp-html alternative', async () => {
		const amp = '<!doctype html><html ⚡4email><head></head><body>amp</body></html>';

		await sendToMx(createJob({ amp }), config, redis, '10.0.0.1');

		expect(rawOf()).toContain('text/x-amp-html');
	});

	it('omits the amp alternative when the job has no AMP body', async () => {
		await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(rawOf()).not.toContain('x-amp-html');
	});

	it('forwards the campaign List-Unsubscribe headers verbatim (angle brackets, single URL)', async () => {
		const listUnsubscribe = '<https://test.convex.site/unsub/contact-123:1700000000000:sigabc>';
		const job = createJob({
			ipPool: 'campaign',
			headers: {
				'List-Unsubscribe': listUnsubscribe,
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			},
		});

		await sendToMx(job, config, redis, '10.0.0.2');

		expect(headerValueOf(0, 'List-Unsubscribe')).toBe(listUnsubscribe);
		expect(headerValueOf(0, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
	});

	it('spreads job.headers onto the wire (RFC 3834 vacation auto-reply stamps)', async () => {
		const headers = {
			'Auto-Submitted': 'auto-replied',
			'X-Auto-Response-Suppress': 'All',
			Precedence: 'auto_reply',
		};

		await sendToMx(createJob({ headers }), config, redis, '10.0.0.1');

		expect(headerValueOf(0, 'Auto-Submitted')).toBe('auto-replied');
		expect(headerValueOf(0, 'X-Auto-Response-Suppress')).toBe('All');
		expect(headerValueOf(0, 'Precedence')).toBe('auto_reply');
		// The MTA's own tracing headers are added alongside, not replaced.
		expect(headerValueOf(0, 'X-Owlat-Message-Id')).toBe('msg-001');
		expect(headerValueOf(0, 'X-Owlat-Org-Id')).toBe('org-1');
	});

	it('always supplies a non-empty text part (falls back to stripped HTML when the job has no text)', async () => {
		const job = createJob({ html: '<p>Hello there</p>', text: undefined });

		await sendToMx(job, config, redis, '10.0.0.1');

		expect(rawOf()).toContain('Hello there');
		expect(rawOf()).toContain('text/plain');
	});

	it('uses the explicit text part when the job provides one', async () => {
		const job = createJob({ html: '<p>HTML body</p>', text: 'Plain text body' });

		await sendToMx(job, config, redis, '10.0.0.1');

		expect(rawOf()).toContain('Plain text body');
	});

	it('hands sealed Postbox PGP/MIME to the client as exact raw bytes', async () => {
		const mime =
			'From: sender@owlat.com\r\nSubject: sealed\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n\r\nciphertext';

		await sendToMx(
			createJob({ sealedMimeBase64: Buffer.from(mime).toString('base64') }),
			config,
			redis,
			'10.0.0.1'
		);

		// No DKIM key configured (default) → the sealed bytes go on the wire verbatim.
		expect(rawOf()).toBe(mime);
		// The envelope still carries the VERP return-path.
		const env = sendEnvelopeMock.mock.calls[0]![1] as { from: string; to: string[] };
		expect(env.from).toBe('bounce+encoded@bounces.owlat.com');
		expect(env.to).toEqual(['user@example.com']);
	});

	it('pins tls.minVersion TLSv1.2 when acquiring an outbound connection (RFC 8996/9325)', async () => {
		await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(acquireMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.objectContaining({ tls: expect.objectContaining({ minVersion: 'TLSv1.2' }) })
		);
	});

	it('composes deterministic bytes for the send (From-aligned, VERP envelope)', async () => {
		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
		expect(result.success).toBe(true);
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
		expect(headerBlockOf(0)).toMatch(/^From: sender@owlat\.com\r?$/m);
		const env = sendEnvelopeMock.mock.calls[0]![1] as { from: string; to: string[] };
		expect(env.from).toBe('bounce+encoded@bounces.owlat.com');
	});

	it('emits Date(+0000)/MIME-Version 1.0/From/non-empty To in the generated message', async () => {
		const result = await sendToMx(
			createJob({ from: 'sender@owlat.com', to: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);
		expect(result.success).toBe(true);

		const headers = headerBlockOf(0);
		expect(headers).toMatch(/^Date: .+\+0000$/m);
		expect(headers).not.toMatch(/^Date: .+GMT$/m);
		expect(headers).toMatch(/^MIME-Version: 1\.0\r?$/m);
		expect(headers).toMatch(/^From: sender@owlat\.com\r?$/m);
		const toValue = headerValueOf(0, 'To');
		expect(toValue).toBeDefined();
		expect(toValue).toContain('user@example.com');
	});

	it('stamps a From-domain-aligned Message-ID (not the VERP bounce domain)', async () => {
		config = createConfig({ returnPathDomain: 'bounces.example.com' });

		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const messageId = headerValueOf(0, 'Message-ID');
		expect(messageId).toMatch(/^<[^@>]+@example\.com>$/);
		expect(messageId).not.toContain('bounces.example.com');
	});

	it('sets the Message-ID header exactly once', async () => {
		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const count = (headerBlockOf(0).match(/^Message-ID:/gim) ?? []).length;
		expect(count).toBe(1);
	});

	it('generates a distinct Message-ID for each send', async () => {
		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');
		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const first = headerValueOf(0, 'Message-ID');
		const second = headerValueOf(1, 'Message-ID');
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});

	it('respects a caller-supplied Message-ID header (does not override)', async () => {
		const supplied = '<agent-reply-123@example.com>';

		await sendToMx(
			createJob({ from: 'user@example.com', headers: { 'Message-ID': supplied } }),
			config,
			redis,
			'10.0.0.1'
		);

		expect(headerValueOf(0, 'Message-ID')).toBe(supplied);
	});

	describe('per-IP EHLO hostname', () => {
		it('announces the mapped EHLO name for the bind IP', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail1.owlat.com' })
			);
		});

		it('falls back to the global EHLO name for an unmapped bind IP', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.9');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.9',
				expect.objectContaining({ name: 'fallback.owlat.com' })
			);
		});

		it('two bind IPs each announce their own distinct EHLO name', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');
			await sendToMx(createJob(), mapped, redis, '10.0.0.2');

			const namesByBindIp = new Map<string, string>();
			for (const call of acquireMock.mock.calls) {
				const bindIp = call[1] as string;
				const opts = call[2] as { name?: string };
				if (opts.name) namesByBindIp.set(bindIp, opts.name);
			}
			expect(namesByBindIp.get('10.0.0.1')).toBe('mail1.owlat.com');
			expect(namesByBindIp.get('10.0.0.2')).toBe('mail2.owlat.com');
		});

		it('announces config.ehloHostname for the bind IP when there is no per-IP override', async () => {
			const single = createConfig({ ehloHostname: 'mail.test.example', ehloHostnames: {} });

			await sendToMx(createJob(), single, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail.test.example' })
			);
			expect(acquireOpts(0).name).not.toBe(osHostname());
		});
	});

	// recordTlsResult is fire-and-forget in the sender, so flush the microtask
	// queue before reading what landed in the (mock) Redis, then read the day's
	// aggregate back through the real generateReport (RFC 8460 §3/§4.3/§4.4).
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

	async function reportFor(): Promise<NonNullable<Awaited<ReturnType<typeof generateReport>>>> {
		await flush();
		const today = new Date().toISOString().split('T')[0]!;
		const report = await generateReport(
			redis as unknown as Parameters<typeof generateReport>[0],
			'example.com',
			today,
			'Owlat MTA',
			'postmaster@owlat.com'
		);
		expect(report).not.toBeNull();
		return report!;
	}

	describe('MTA-STS enforce policy is carried into the acquire (PR-25 item 2)', () => {
		it('passes requireTLS:true + tls.rejectUnauthorized:true when the policy enforces', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx1.example.com', 'mx2.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				'mx1.example.com',
				'10.0.0.1',
				expect.objectContaining({
					requireTLS: true,
					tls: expect.objectContaining({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }),
				})
			);
		});

		it('skips (and logs) an MX host not listed in the enforce policy, delivering via the permitted one', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx2.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			const acquiredHosts = acquireMock.mock.calls.map((c) => c[0]);
			expect(acquiredHosts).not.toContain('mx1.example.com');
			expect(acquiredHosts).toContain('mx2.example.com');
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.objectContaining({ mxHost: 'mx1.example.com' }),
				expect.stringContaining('not permitted by MTA-STS policy')
			);
		});

		it('all MX hosts excluded by the policy => no acquire, soft bounce (retryable)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx-elsewhere.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(acquireMock).not.toHaveBeenCalled();
		});
	});

	describe('multi-MX TLS failover (PR-25 item 5)', () => {
		// A STARTTLS handshake failure surfaces as an SmtpError with a structured
		// tlsCause and no reply code — a transient error the loop treats as "try
		// the next MX" (RFC 5321 §4.5.4.1), never a hard bounce.
		const tlsHandshakeError = () =>
			smtpError({
				phase: 'starttls',
				message: 'handshake failure',
				tlsCause: 'handshake',
				secured: false,
			});

		it('first MX fails on TLS, second MX resolves => success', async () => {
			connectMock.mockRejectedValueOnce(tlsHandshakeError()).mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(connectMock).toHaveBeenCalledTimes(2); // tried both MX
			expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
		});

		it('every MX fails on TLS => soft bounce (retryable) + TLS-RPT validation-failure recorded', async () => {
			connectMock.mockRejectedValue(tlsHandshakeError());

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(connectMock).toHaveBeenCalledTimes(2);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(2);
			const details = policy['failure-details']!;
			const validationFailures = details.filter((d) => d['result-type'] === 'validation-failure');
			expect(validationFailures.length).toBe(2);
			const recordedHosts = validationFailures.map((d) => d['receiving-mx-hostname']);
			expect(recordedHosts).toContain('mx1.example.com');
			expect(recordedHosts).toContain('mx2.example.com');
		});
	});

	describe('MTA-STS enforce wiring (PR-35)', () => {
		it('forwards enforce requireTLS + rejectUnauthorized to acquire unchanged', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireOpts(0).requireTLS).toBe(true);
			expect(acquireOpts(0).tls?.rejectUnauthorized).toBe(true);
		});

		it('an opportunistic (none) policy forwards requireTLS:false / rejectUnauthorized:false', async () => {
			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireOpts(0).requireTLS).toBe(false);
			expect(acquireOpts(0).tls?.rejectUnauthorized).toBe(false);
		});

		it('a requireTLS send to a server with no STARTTLS soft/deferred-bounces (not a hard bounce)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'server does not advertise STARTTLS but TLS is required',
					tlsCause: 'starttls-unavailable',
					secured: false,
				})
			);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(['soft', 'deferred']).toContain(result.bounceType);
			expect(result.bounceType).not.toBe('hard');
		});
	});

	describe('MTA-STS TLS-RPT recording', () => {
		it('records sts-policy-invalid for an enforce policy MX not in the policy (was previously inert)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['aspmx.l.google.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(acquireMock).not.toHaveBeenCalled();

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			expect(policy.policy['policy-string']).toContain('mode: enforce');
			expect(policy.policy['mx-host']).toEqual(['aspmx.l.google.com']);
			const details = policy['failure-details']!;
			expect(
				details.filter((d) => d['result-type'] === 'sts-policy-invalid').length
			).toBeGreaterThanOrEqual(1);
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
		});

		it('attributes a cert hostname mismatch under enforce as sts-webpki-invalid', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'Hostname/IP does not match certificate altname',
					tlsCause: 'cert-host-mismatch',
					secured: false,
				})
			);

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-webpki-invalid')).toBeDefined();
			expect(details.find((d) => d['result-type'] === 'certificate-host-mismatch')).toBeUndefined();
		});

		it('testing mode + STARTTLS-stripping server: records a failure but still delivers', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: false,
				rejectUnauthorized: false,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'testing',
			});
			// The verifying probe (requireTLS:true) fails because STARTTLS is stripped;
			// the opportunistic retry on the same MX then delivers in cleartext.
			connectMock
				.mockRejectedValueOnce(
					smtpError({
						phase: 'starttls',
						message: 'server does not advertise STARTTLS but TLS is required',
						tlsCause: 'starttls-unavailable',
						secured: false,
					})
				)
				.mockResolvedValue(liveConn(false));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			// probe + opportunistic retry on the same MX.
			expect(connectMock).toHaveBeenCalledTimes(2);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			// The cleartext retry is NOT a TLS success (PR-24): both the stripped probe
			// and the cleartext retry are STS-attributed sts-policy-invalid.
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-policy-invalid')).toBeDefined();
		});
	});

	describe('TLS-RPT records the real session result type per delivery (PR-24)', () => {
		it('records starttls-not-supported (not success) for a cleartext delivery with no policy', async () => {
			// The connection never negotiated STARTTLS → secured stays false → a
			// plaintext session, recorded as starttls-not-supported (never success).
			connectMock.mockResolvedValue(liveConn(false));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(1);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'starttls-not-supported')).toBeDefined();
			expect(details.find((d) => d['result-type'] === 'success')).toBeUndefined();
		});

		it('records a TLS success when the connection negotiated STARTTLS', async () => {
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(1);
			expect(policy.summary['total-failure-session-count']).toBe(0);
		});
	});

	// ── T3: DANE at send time (RFC 7672), DANE_MODE off/report/enforce ───────
	describe('DANE at send time (T3)', () => {
		const CERT_SPKI_SHA256 = '49fc4a5424807bbbde5617d8b4bb563a79f4566c28d4d9b2e917dddcc7bac89c';
		const MATCHING_TLSA = { usage: 3, selector: 1, matchingType: 1, data: CERT_SPKI_SHA256 };
		const MISMATCH_TLSA = { usage: 3, selector: 1, matchingType: 1, data: 'deadbeef'.repeat(8) };

		function fixturePeerCert(): PeerCertificate {
			return { raw: new X509Certificate(MX_CERT).raw } as unknown as PeerCertificate;
		}
		function fixtureTlsSocket(): TLSSocket {
			return { getPeerCertificate: () => fixturePeerCert() } as unknown as TLSSocket;
		}
		function daneConfig(mode: 'report' | 'enforce' = 'enforce'): MtaConfig {
			return createConfig({ daneMode: mode, daneResolverUrl: 'https://doh.example/dns-query' });
		}

		it('mode OFF => resolver never consulted; acquire has no DANE hook (byte-identical to T1)', async () => {
			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			const tlsOpts = acquireOpts(0).tls ?? {};
			expect(tlsOpts).not.toHaveProperty('checkServerIdentity');
			expect(tlsOpts).not.toHaveProperty('verifyPeerCertificate');
		});

		it.each(['report', 'enforce'] as const)(
			'mode %s with NO resolver => inert (resolver never consulted, no DANE hook)',
			async (mode) => {
				const result = await sendToMx(
					createJob(),
					createConfig({ daneMode: mode }),
					redis,
					'10.0.0.1'
				);

				expect(result.success).toBe(true);
				expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
				const tlsOpts = acquireOpts(0).tls ?? {};
				expect(tlsOpts).not.toHaveProperty('verifyPeerCertificate');
			}
		);

		it('DANE enabled but no usable TLSA => falls through to the non-DANE path', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).toHaveBeenCalled();
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});

		it('a TLSA lookup FAILURE (SERVFAIL/outage) defers — never downgrades to non-DANE', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('an enforce-mode DNSSEC MX discovery failure defers before TLSA lookup', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'MX DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
			expect(result.error).toContain('DANE MX discovery failed');
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('an indeterminate address lookup defers in enforce mode instead of downgrading', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'destinations',
				destinations: [
					{
						mxHostname: 'mx.example.com',
						preference: 10,
						mxSecurity: 'secure',
						addressSecurity: 'indeterminate',
						addresses: [],
					},
				],
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
			expect(result.error).toContain('address discovery indeterminate');
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('a report-mode MX discovery failure delivers normally without a misleading DANE probe', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'MX DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});

		it('DANE-EE uses the post-handshake verifier without requiring WebPKI', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			const opts = acquireOpts(0);
			expect(opts.requireTLS).toBe(true);
			expect(opts.tls?.rejectUnauthorized).toBe(false);
			expect(typeof opts.tls?.verifyPeerCertificate).toBe('function');
			expect(opts.tls?.danePolicyFingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(opts.tls?.checkServerIdentity).toBeUndefined();
		});

		it('the DANE hook accepts a matching MX certificate and rejects a mismatch', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			const check = acquireOpts(0).tls!.verifyPeerCertificate!;
			expect(check(fixtureTlsSocket())).toBeUndefined();

			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');
			const mismatchCheck = acquireMock.mock.calls.at(-1)![2].tls.verifyPeerCertificate!;
			const verdict = mismatchCheck(fixtureTlsSocket());
			expect(verdict).toBeInstanceOf(Error);
			expect((verdict as Error).message).toContain('DANE TLSA mismatch');
		});

		it('a TLSA mismatch defers (soft bounce) and records a validation-failure under the tlsa policy', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			// The post-handshake verifier rejects → the client fails the connection
			// closed with tlsCause 'handshake' (a TLS failure with no reply code).
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'peer certificate verification failed: DANE TLSA mismatch',
					tlsCause: 'handshake',
					secured: false,
				})
			);

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.policy['policy-string']).toContain(`3 1 1 ${MISMATCH_TLSA.data}`);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'validation-failure')).toBeDefined();
		});

		it('report + matching TLSA => delivers and emits a TLS-RPT success under the tlsa policy', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireMock).toHaveBeenCalledTimes(1);
			expect(typeof acquireOpts(0).tls?.verifyPeerCertificate).toBe('function');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.summary['total-successful-session-count']).toBe(1);
		});

		it('report + TLSA MISMATCH => NO bounce, NO DANE requireTLS on delivery, but the validation-failure is still emitted', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			// Probe (call 0) aborts on the TLSA mismatch; the report-only fallback
			// (call 1) delivers over the normal opportunistic floor.
			connectMock
				.mockRejectedValueOnce(
					smtpError({
						phase: 'starttls',
						message: 'peer certificate verification failed: DANE TLSA mismatch',
						tlsCause: 'handshake',
						secured: false,
					})
				)
				.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireMock).toHaveBeenCalledTimes(2);

			const probeOpts = acquireOpts(0);
			expect(probeOpts.requireTLS).toBe(true);
			expect(typeof probeOpts.tls?.verifyPeerCertificate).toBe('function');

			const deliverOpts = acquireOpts(1);
			expect(deliverOpts.requireTLS).toBe(false);
			expect(deliverOpts.tls ?? {}).not.toHaveProperty('verifyPeerCertificate');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.policy['policy-string']).toContain(`3 1 1 ${MISMATCH_TLSA.data}`);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'validation-failure')).toBeDefined();
		});

		it('report + TLSA lookup FAILURE => delivers on the normal path (never defers)', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});
	});
});
