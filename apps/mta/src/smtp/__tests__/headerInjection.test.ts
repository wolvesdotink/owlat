import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

/**
 * Regression-lock for audit item PR-43 (Header-injection, RFC 5322 §2.2).
 *
 * The MTA `sendToMx` path hands `job.subject` / `job.from` / `job.replyTo` and
 * the `job.headers` map to the in-house composer (@owlat/mail-message). This
 * test feeds those fields values that contain a bare CRLF + a smuggled `Bcc:`
 * header, captures the actual RFC 5322 bytes the composer emits (handed to the
 * SMTP client's sendEnvelope), and asserts they contain NO injected `Bcc:`
 * header line.
 *
 * This locks the transport-side guarantee in place. The Convex producer also
 * strips CR/LF before the job is ever built, so the two layers together are
 * defense-in-depth: a CRLF would have to survive BOTH to reach the wire.
 */

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
	PoolOverCapError: class PoolOverCapError extends Error {},
}));
vi.mock('../mxResolver.js', () => ({
	getMxHostnames: vi.fn().mockResolvedValue(['mx1.example.com']),
}));
vi.mock('../dkim.js', () => ({
	getDkimOptions: vi.fn().mockResolvedValue(undefined),
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

import { sendToMx } from '../sender.js';
import { getMxHostnames } from '../mxResolver.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

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
		mtaSecret: 'test-mta-secret-at-least-32-bytes-long!!',
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
		submissionImplicitTlsPort: 465,
		submissionImplicitTlsEnabled: false,
		submissionMaxConnectionsPerIp: 10,
		submissionMaxClients: 200,
		submissionMaxAuthFailuresPerIp: 10,
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
		inboundDkimEnabled: false,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		maxMessageAgeMs: 432_000_000,
		...overrides,
	} satisfies MtaConfig;
}

describe('sendToMx — header injection (PR-43)', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		redis = new Redis();
		config = createConfig();
		vi.mocked(getMxHostnames).mockResolvedValue(['mx1.example.com']);
		acquireMock.mockReturnValue({
			key: 'test-key',
			config: {
				host: 'mx1.example.com',
				port: 25,
				ehloName: 'mail.owlat.com',
				tlsMode: 'starttls',
			},
		});
		connectMock.mockResolvedValue({ secured: true, close: vi.fn() });
		sendEnvelopeMock.mockResolvedValue({
			accepted: [],
			rejected: [],
			response: { code: 250, text: '2.0.0 OK', lines: ['2.0.0 OK'] },
		});
		quitMock.mockResolvedValue(undefined);
	});

	/** The RFC 5322 bytes the composer emitted for a job. */
	async function captureMessage(job: EmailJob): Promise<string> {
		const result = await sendToMx(job, config, redis, '10.0.0.1');
		expect(result.success).toBe(true);
		const options = sendEnvelopeMock.mock.calls[0]![1] as { data: Buffer };
		return options.data.toString('utf-8');
	}

	function headerBlockOf(message: string): string {
		return message.split('\r\n\r\n')[0]!;
	}

	it('a CRLF + Bcc smuggled into the SUBJECT does not emit a Bcc header line', async () => {
		const message = await captureMessage(createJob({ subject: 'Hi there\r\nBcc: x@evil.com' }));
		expect(headerBlockOf(message)).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into the FROM does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ from: 'sender@owlat.com\r\nBcc: x@evil.com' })
		);
		expect(headerBlockOf(message)).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into the REPLY-TO does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ replyTo: 'reply@owlat.com\r\nBcc: x@evil.com' })
		);
		expect(headerBlockOf(message)).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into a custom header VALUE does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ headers: { 'X-Custom': 'value\r\nBcc: x@evil.com' } })
		);
		expect(headerBlockOf(message)).not.toMatch(/^Bcc:/im);
	});

	it('all injection vectors at once still emit no Bcc header line', async () => {
		const message = await captureMessage(
			createJob({
				subject: 'S\r\nBcc: a@evil.com',
				from: 'sender@owlat.com\r\nBcc: b@evil.com',
				replyTo: 'reply@owlat.com\r\nBcc: c@evil.com',
				headers: { 'X-Custom': 'v\r\nBcc: d@evil.com' },
			})
		);
		expect(headerBlockOf(message)).not.toMatch(/^Bcc:/im);
	});
});
