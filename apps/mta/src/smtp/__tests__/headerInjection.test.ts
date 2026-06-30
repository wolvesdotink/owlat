import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

/**
 * Regression-lock for audit item PR-43 (Header-injection, RFC 5322 §2.2).
 *
 * The MTA `sendToMx` path hands `job.subject` / `job.from` / `job.replyTo` and
 * the `job.headers` map straight to nodemailer's `transport.sendMail`. This
 * test swaps in a REAL nodemailer stream transport (the same idiom as the
 * PR-52 regression-lock in sender.test.ts), feeds those fields values that
 * contain a bare CRLF + a smuggled `Bcc:` header, and asserts the actual RFC
 * 5322 bytes nodemailer emits contain NO injected `Bcc:` header line.
 *
 * This locks the transport-side guarantee in place. The Convex producer now
 * also strips CR/LF before the job is ever built (personalization `header`
 * escape policy + instanceMailer), so the two layers together are
 * defense-in-depth: a CRLF would have to survive BOTH to reach the wire.
 */

const { mockTransport } = vi.hoisted(() => {
	const mockTransport = { sendMail: vi.fn() };
	return { mockTransport };
});

vi.mock('../connectionPool.js', () => ({
	pool: {
		acquire: vi.fn().mockReturnValue({ key: 'test-key', transport: mockTransport }),
		release: vi.fn(),
	},
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
import { pool } from '../connectionPool.js';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
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
	};
}

describe('sendToMx — header injection (PR-43)', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		redis = new Redis();
		config = createConfig();
		vi.mocked(getMxHostnames).mockResolvedValue(['mx1.example.com']);
		vi.mocked(pool.acquire).mockReturnValue({
			key: 'test-key',
			transport: mockTransport as unknown as Transporter,
		});
	});

	/**
	 * Build the actual MIME bytes nodemailer would emit for a job, by swapping
	 * a real stream transport in for the mocked one and capturing the message.
	 */
	async function captureMessage(job: EmailJob): Promise<string> {
		const streamTransport = nodemailer.createTransport({
			streamTransport: true,
			buffer: true,
			newline: 'windows',
		});
		let captured = '';
		const capturingTransport = {
			sendMail: async (opts: Parameters<Transporter['sendMail']>[0]) => {
				const info = await streamTransport.sendMail(opts);
				captured = (info.message as Buffer).toString('utf-8');
				return info;
			},
		};
		vi.mocked(pool.acquire).mockReturnValue({
			key: 'stream-key',
			transport: capturingTransport as unknown as Transporter,
		});

		const result = await sendToMx(job, config, redis, '10.0.0.1');
		expect(result.success).toBe(true);
		return captured;
	}

	function headerBlockOf(message: string): string {
		return message.split('\r\n\r\n')[0]!;
	}

	it('a CRLF + Bcc smuggled into the SUBJECT does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ subject: 'Hi there\r\nBcc: x@evil.com' }),
		);
		const headers = headerBlockOf(message);
		expect(headers).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into the FROM does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ from: 'sender@owlat.com\r\nBcc: x@evil.com' }),
		);
		const headers = headerBlockOf(message);
		expect(headers).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into the REPLY-TO does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ replyTo: 'reply@owlat.com\r\nBcc: x@evil.com' }),
		);
		const headers = headerBlockOf(message);
		expect(headers).not.toMatch(/^Bcc:/im);
	});

	it('a CRLF + Bcc smuggled into a custom header VALUE does not emit a Bcc header line', async () => {
		const message = await captureMessage(
			createJob({ headers: { 'X-Custom': 'value\r\nBcc: x@evil.com' } }),
		);
		const headers = headerBlockOf(message);
		expect(headers).not.toMatch(/^Bcc:/im);
	});

	it('all injection vectors at once still emit no Bcc header line', async () => {
		const message = await captureMessage(
			createJob({
				subject: 'S\r\nBcc: a@evil.com',
				from: 'sender@owlat.com\r\nBcc: b@evil.com',
				replyTo: 'reply@owlat.com\r\nBcc: c@evil.com',
				headers: { 'X-Custom': 'v\r\nBcc: d@evil.com' },
			}),
		);
		const headers = headerBlockOf(message);
		expect(headers).not.toMatch(/^Bcc:/im);
	});
});
