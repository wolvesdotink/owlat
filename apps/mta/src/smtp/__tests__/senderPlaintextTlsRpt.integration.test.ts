/**
 * Regression-lock for audit item PR-24 (Outbound TLS — RFC 8460 TLS-RPT).
 *
 * The MX sender used to call `recordTlsResult(..., 'success')` UNCONDITIONALLY
 * after `transport.sendMail` resolved. A plaintext delivery — the recipient MX
 * did not advertise STARTTLS and no policy required TLS (opportunistic,
 * `requireTLS:false`) — resolves with no error, so it was being logged as a TLS
 * 'success', overstating our encryption coverage to the recipient domain owner.
 *
 * nodemailer exposes no secured flag on `info`, so the fix wires a per-send
 * secured-state capture (see tlsSecuredCapture.ts + connectionPool's logger) and
 * records RFC 8460 `starttls-not-supported` for a cleartext session instead of
 * `success`.
 *
 * Unlike sender.test.ts (which mocks the connection pool), this test drives the
 * FULL `sendToMx` through the REAL {@link SmtpConnectionPool} + real nodemailer
 * against a real loopback {@link SMTPServer} — one that hides STARTTLS and one
 * that advertises it — so the secured-state detection is observed against an
 * actual handshake, not a mock's say-so. Only the destination port is rewritten
 * (the loopback server listens on an ephemeral port; sendToMx hardcodes 25).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis-mock';
import { MX_CERT, MX_KEY } from './certFixture.js';

// Resolvers/config deps are mocked (per-test policy + MX); the connection pool,
// nodemailer, and tlsRpt are REAL so the secured-state capture and TLS-RPT
// recording run end-to-end.
vi.mock('../mxResolver.js', () => ({
	getMxHostnames: vi.fn().mockResolvedValue(['127.0.0.1']),
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
vi.mock('../../bounce/verp.js', () => ({
	buildVerpAddress: vi.fn().mockReturnValue('bounce+encoded@bounces.owlat.com'),
}));
vi.mock('../../queue/groups.js', () => ({
	extractDomain: vi.fn().mockReturnValue('recipient.test'),
	buildGroupKey: vi.fn((pool: string, domain: string) => `${pool}:${domain}`),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendToMx } from '../sender.js';
import { pool } from '../connectionPool.js';
import { generateReport } from '../tlsRpt.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

interface ServerProbe {
	server: SMTPServer;
	port: number;
	/** Whether the DATA command arrived on an upgraded (TLS) session. */
	dataOverTls(): boolean | null;
}

/**
 * Start a loopback SMTP server. `hideSTARTTLS:true` makes the EHLO response OMIT
 * the STARTTLS capability (the PR-24 scenario); `false` advertises it so a
 * client upgrades opportunistically. The server starts in cleartext, so a
 * session is only `secure` if the client issued STARTTLS (RFC 3207).
 */
async function startServer(hideSTARTTLS: boolean): Promise<ServerProbe> {
	let dataSecure: boolean | null = null;

	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: ['AUTH'],
		hideSTARTTLS,
		cert: MX_CERT,
		key: MX_KEY,
		minVersion: 'TLSv1.2',
		onData(stream, session, cb) {
			dataSecure = session.secure === true;
			stream.on('data', () => {});
			stream.on('end', () => cb());
		},
	});
	server.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	return { server, port, dataOverTls: () => dataSecure };
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-plaintext-001',
		to: 'user@recipient.test',
		from: 'sender@owlat.com',
		subject: 'PR-24',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		...overrides,
	};
}

function createConfig(): MtaConfig {
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
		ipPools: { transactional: ['127.0.0.1'], campaign: ['127.0.0.1'] },
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
	} as MtaConfig;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('sendToMx records the real TLS-RPT result type per session (PR-24)', () => {
	let redis: InstanceType<typeof Redis>;
	let probe: ServerProbe | undefined;
	let config: MtaConfig;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		config = createConfig();
		// sendToMx hardcodes port 25, but the loopback server listens on an ephemeral
		// port. Spy on the REAL pool and rewrite only the port, so the real transport
		// (with the securedCaptureLogger) and the real nodemailer handshake still run.
		// bindIp '127.0.0.1' keeps the source address on loopback.
		const realAcquire = pool.acquire.bind(pool);
		vi.spyOn(pool, 'acquire').mockImplementation((mxHost, bindIp, options) =>
			realAcquire(mxHost, bindIp, { ...options, port: probe!.port }),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await pool.closeAll(500);
		if (probe) await stopServer(probe.server);
		probe = undefined;
	});

	async function reportFor() {
		await flush();
		const today = new Date().toISOString().split('T')[0]!;
		const report = await generateReport(
			redis as unknown as Parameters<typeof generateReport>[0],
			'recipient.test',
			today,
			'Owlat MTA',
			'postmaster@owlat.com',
		);
		expect(report).not.toBeNull();
		return report!;
	}

	it('plaintext delivery (MX hides STARTTLS, no policy) is recorded as starttls-not-supported, not success', async () => {
		probe = await startServer(/* hideSTARTTLS */ true);

		const result = await sendToMx(createJob(), config, redis, '127.0.0.1');

		// The message is still DELIVERED (opportunistic TLS never blocks delivery).
		expect(result.success).toBe(true);
		// …and the server confirms DATA arrived in cleartext (no STARTTLS upgrade).
		expect(probe.dataOverTls()).toBe(false);

		const report = await reportFor();
		const policy = report.policies[0]!;
		// The cleartext session is NOT counted as a TLS success.
		expect(policy.summary['total-successful-session-count']).toBe(0);
		expect(policy.summary['total-failure-session-count']).toBe(1);
		const details = policy['failure-details']!;
		expect(details.find((d) => d['result-type'] === 'starttls-not-supported')).toBeDefined();
		expect(details.find((d) => d['result-type'] === 'success')).toBeUndefined();
	}, 15000);

	it('an encrypted delivery (MX advertises STARTTLS) is still recorded as a TLS success', async () => {
		probe = await startServer(/* hideSTARTTLS */ false);

		const result = await sendToMx(createJob(), config, redis, '127.0.0.1');

		expect(result.success).toBe(true);
		// DATA rode the upgraded TLS session.
		expect(probe.dataOverTls()).toBe(true);

		const report = await reportFor();
		const policy = report.policies[0]!;
		expect(policy.summary['total-successful-session-count']).toBe(1);
		expect(policy.summary['total-failure-session-count']).toBe(0);
	}, 15000);
});
