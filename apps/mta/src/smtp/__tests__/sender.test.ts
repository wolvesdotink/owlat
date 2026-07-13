import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hostname as osHostname } from 'node:os';
import Redis from 'ioredis-mock';

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
	getMxHostnames: vi.fn().mockResolvedValue(['mx1.example.com', 'mx2.example.com']),
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

import { sendToMx } from '../sender.js';
import { securedCaptureLogger } from '../tlsSecuredCapture.js';
import { getStsTlsOptions } from '../mtaSts.js';
import { getMxHostnames } from '../mxResolver.js';
import { generateReport } from '../tlsRpt.js';
import { pool } from '../connectionPool.js';
import { lookupTlsaRecords } from '../daneResolver.js';
import { logger } from '../../monitoring/logger.js';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { MX_CERT } from './certFixture.js';
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

describe('sendToMx', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		// ioredis-mock shares one in-memory keyspace across instances, so clear it
		// between tests — otherwise TLS-RPT aggregates (and the persisted policy
		// context) from one test leak into the next under the same domain/day key.
		await redis.flushall();
		config = createConfig();

		// Re-establish default mock return values (clearAllMocks doesn't reset these)
		vi.mocked(getMxHostnames).mockResolvedValue(['mx1.example.com', 'mx2.example.com']);
		vi.mocked(pool.acquire).mockReturnValue({
			key: 'test-key',
			transport: mockTransport as unknown as Transporter,
		});
		// Default: no MTA-STS policy (opportunistic TLS). Enforce tests override.
		vi.mocked(getStsTlsOptions).mockResolvedValue({
			requireTLS: false,
			rejectUnauthorized: false,
			allowedMxHosts: [],
			policyMode: 'none',
		});
	});

	it('returns hard bounce when no MX records found', async () => {
		vi.mocked(getMxHostnames).mockResolvedValue([]);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
	});

	it('returns success with remoteMessageId parsed from response', async () => {
		mockTransport.sendMail.mockResolvedValue({
			response: '250 2.0.0 OK <remote-id@mx.example.com>',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(result.smtpCode).toBe(250);
		expect(result.remoteMessageId).toBe('remote-id@mx.example.com');
	});

	it('returns hard bounce on 5xx SMTP error and stops trying', async () => {
		mockTransport.sendMail.mockRejectedValue({
			responseCode: 550,
			response: '550 5.1.1 User unknown',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
		// Should only try the first MX, not continue to the second
		expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
	});

	it('returns soft bounce for 5.2.2 (mailbox full) despite 5xx code', async () => {
		mockTransport.sendMail.mockRejectedValue({
			responseCode: 552,
			response: '552 5.2.2 Mailbox full',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(result.enhancedCode).toBe('5.2.2');
	});

	it('returns deferred on 4xx SMTP error', async () => {
		mockTransport.sendMail.mockRejectedValue({
			responseCode: 450,
			response: '450 4.7.1 Try again later',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('deferred');
		expect(result.smtpCode).toBe(450);
	});

	it('tries next MX host on connection error', async () => {
		// First call: connection error (no responseCode), second call: success
		mockTransport.sendMail
			.mockRejectedValueOnce({ message: 'ECONNREFUSED' })
			.mockResolvedValueOnce({ response: '250 OK' });

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(true);
		expect(mockTransport.sendMail).toHaveBeenCalledTimes(2);
	});

	it('returns soft bounce when all MX hosts fail with connection errors', async () => {
		mockTransport.sendMail.mockRejectedValue({ message: 'ECONNREFUSED' });

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(mockTransport.sendMail).toHaveBeenCalledTimes(2); // Tried both MX hosts
	});

	it('forwards an AMP body to nodemailer as the amp option', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
		const amp = '<!doctype html><html ⚡4email><head></head><body>amp</body></html>';

		await sendToMx(createJob({ amp }), config, redis, '10.0.0.1');

		expect(mockTransport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ amp }));
	});

	it('omits the amp option when the job has no AMP body', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		await sendToMx(createJob(), config, redis, '10.0.0.1');

		const arg = mockTransport.sendMail.mock.calls[0]![0] as Record<string, unknown>;
		expect('amp' in arg).toBe(false);
	});

	// ── RFC 8058 / RFC 2369 List-Unsubscribe passthrough (audit PR-20) ──────────
	//
	// A campaign EmailJob carries the one-click unsubscribe header assembled on
	// the Convex side (delivery/unsubscribe.ts getListUnsubscribeHeader). The MTA
	// sender must pass it through to nodemailer verbatim — a single HTTPS URL in
	// RFC 2369 angle brackets — alongside the `List-Unsubscribe-Post:
	// List-Unsubscribe=One-Click` companion. Stripping or reformatting it would
	// break the mail client's one-click button. The sender must also always emit
	// a non-empty text part (RFC 8058 §4 / multipart deliverability) — it falls
	// back to a stripped-HTML body when the job supplies no explicit text.

	it('forwards the campaign List-Unsubscribe headers to nodemailer verbatim (angle brackets, single URL)', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		const listUnsubscribe = '<https://test.convex.site/unsub/contact-123:1700000000000:sigabc>';
		const job = createJob({
			ipPool: 'campaign',
			headers: {
				'List-Unsubscribe': listUnsubscribe,
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			},
		});

		await sendToMx(job, config, redis, '10.0.0.2');

		const arg = mockTransport.sendMail.mock.calls[0]![0] as {
			headers: Record<string, string>;
		};
		// Exact passthrough — single URL, RFC 2369 angle brackets, no extra
		// mailto/comma entries injected.
		expect(arg.headers['List-Unsubscribe']).toBe(listUnsubscribe);
		expect(arg.headers['List-Unsubscribe']).toMatch(/^<https:\/\/[^,<>]+>$/);
		expect(arg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
	});

	it('spreads job.headers onto the wire (RFC 3834 vacation auto-reply stamps)', async () => {
		// The vacation hook (deliveryHooks.runPostDelivery) hands /send the
		// anti-loop headers, /send copies them onto the EmailJob, and the SMTP
		// sender must spread them into the outgoing message so they actually
		// reach the recipient — that's the only thing that stops a remote
		// auto-responder from replying back into a loop.
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
		const headers = {
			'Auto-Submitted': 'auto-replied',
			'X-Auto-Response-Suppress': 'All',
			Precedence: 'auto_reply',
		};

		await sendToMx(createJob({ headers }), config, redis, '10.0.0.1');

		const arg = mockTransport.sendMail.mock.calls[0]![0] as {
			headers: Record<string, string>;
		};
		expect(arg.headers['Auto-Submitted']).toBe('auto-replied');
		expect(arg.headers['X-Auto-Response-Suppress']).toBe('All');
		expect(arg.headers['Precedence']).toBe('auto_reply');
		// The MTA's own tracing headers are added alongside, not replaced.
		expect(arg.headers['X-Owlat-Message-Id']).toBe('msg-001');
		expect(arg.headers['X-Owlat-Org-Id']).toBe('org-1');
	});

	it('always supplies a non-empty text part (falls back to stripped HTML when the job has no text)', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		const job = createJob({ html: '<p>Hello there</p>', text: undefined });

		await sendToMx(job, config, redis, '10.0.0.1');

		const arg = mockTransport.sendMail.mock.calls[0]![0] as { text?: string };
		expect(typeof arg.text).toBe('string');
		expect(arg.text!.length).toBeGreaterThan(0);
		expect(arg.text).toContain('Hello there');
	});

	it('uses the explicit text part when the job provides one', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		const job = createJob({ html: '<p>HTML body</p>', text: 'Plain text body' });

		await sendToMx(job, config, redis, '10.0.0.1');

		const arg = mockTransport.sendMail.mock.calls[0]![0] as { text?: string };
		expect(arg.text).toBe('Plain text body');
	});

	it('pins tls.minVersion TLSv1.2 when acquiring an outbound connection (RFC 8996/9325)', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(pool.acquire).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.objectContaining({
				tls: expect.objectContaining({ minVersion: 'TLSv1.2' }),
			})
		);
	});

	// Regression-lock for audit item PR-52 (Headers/MIME). The bulk MX path
	// hands its mail options to nodemailer; this captures the actual RFC 5322
	// bytes nodemailer emits and asserts the header invariants:
	//   - Date carries a NUMERIC zone (+0000), not the obsolete "GMT" form
	//     (RFC 5322 §3.3 / §3.6.1).
	//   - MIME-Version is exactly "1.0" (RFC 2045 §4).
	//   - From reflects the job's From address (RFC 5322 §3.6.2).
	//   - To is non-empty (RFC 5322 §3.6.3).
	it('emits Date(+0000)/MIME-Version 1.0/From/non-empty To in the generated message', async () => {
		// Swap the mocked transport for a real nodemailer stream transport that
		// actually builds the MIME message, then capture the raw bytes.
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

		const result = await sendToMx(
			createJob({ from: 'sender@owlat.com', to: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);
		expect(result.success).toBe(true);

		const headers = captured.split('\r\n\r\n')[0]!;

		// Date: numeric +0000 offset, never the obsolete "GMT" zone name.
		expect(headers).toMatch(/^Date: .+\+0000$/m);
		expect(headers).not.toMatch(/^Date: .+GMT$/m);

		// MIME-Version is exactly "1.0".
		expect(headers).toMatch(/^MIME-Version: 1\.0\r?$/m);

		// From reflects the job's From; To is present and non-empty.
		expect(headers).toMatch(/^From: sender@owlat\.com\r?$/m);
		const toMatch = headers.match(/^To: (.+)$/m);
		expect(toMatch).not.toBeNull();
		expect(toMatch![1]!.trim().length).toBeGreaterThan(0);
		expect(toMatch![1]).toContain('user@example.com');
	});

	// PR-51 (RFC 5322 §3.6.4): the bulk path never set a Message-ID, so
	// nodemailer auto-derived it from envelope.from = the VERP return-path
	// (bounces.example.com), unaligned with the From sending domain. The sender
	// now stamps an explicit From-aligned Message-ID so nodemailer's
	// getHeader('Message-ID') short-circuits the VERP default.
	function headersOf(call: number): Record<string, string> {
		const arg = mockTransport.sendMail.mock.calls[call]![0] as {
			headers: Record<string, string>;
		};
		return arg.headers;
	}

	it('stamps a From-domain-aligned Message-ID (not the VERP bounce domain)', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
		// returnPathDomain (VERP) intentionally DIFFERS from the From domain.
		config = createConfig({ returnPathDomain: 'bounces.example.com' });

		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const headers = headersOf(0);
		expect(headers['Message-ID']).toMatch(/^<[^@>]+@example\.com>$/);
		// Must NOT be scoped to the VERP / bounce domain.
		expect(headers['Message-ID']).not.toContain('bounces.example.com');
	});

	it('sets the Message-ID header exactly once', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const headerKeys = Object.keys(headersOf(0)).filter((k) => k.toLowerCase() === 'message-id');
		expect(headerKeys).toHaveLength(1);
	});

	it('generates a distinct Message-ID for each send', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');
		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const first = headersOf(0)['Message-ID'];
		const second = headersOf(1)['Message-ID'];
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});

	it('respects a caller-supplied Message-ID header (does not override)', async () => {
		mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
		const supplied = '<agent-reply-123@example.com>';

		await sendToMx(
			createJob({ from: 'user@example.com', headers: { 'Message-ID': supplied } }),
			config,
			redis,
			'10.0.0.1'
		);

		expect(headersOf(0)['Message-ID']).toBe(supplied);
	});

	// ── PR-63 item 1: per-IP EHLO hostname ──
	describe('per-IP EHLO hostname', () => {
		it('announces the mapped EHLO name for the bind IP', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');

			expect(pool.acquire).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail1.owlat.com' })
			);
		});

		it('falls back to the global EHLO name for an unmapped bind IP', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.9');

			expect(pool.acquire).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.9',
				expect.objectContaining({ name: 'fallback.owlat.com' })
			);
		});

		it('two bind IPs each announce their own distinct EHLO name', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');
			await sendToMx(createJob(), mapped, redis, '10.0.0.2');

			const namesByBindIp = new Map<string, string>();
			for (const call of vi.mocked(pool.acquire).mock.calls) {
				const bindIp = call[1] as string;
				const opts = call[2] as { name?: string };
				if (opts.name) namesByBindIp.set(bindIp, opts.name);
			}
			expect(namesByBindIp.get('10.0.0.1')).toBe('mail1.owlat.com');
			expect(namesByBindIp.get('10.0.0.2')).toBe('mail2.owlat.com');
		});

		// ── PR-64: single-IP posture (RFC 5321 §4.1.1.1, Gmail/Yahoo 2024) ──
		// With NO per-IP overrides, sendToMx must announce the global
		// config.ehloHostname for the bind IP — the FQDN that matches that IP's
		// reverse-DNS PTR record — and never an os.hostname()-derived name (the
		// container/host name has no PTR, so FCrDNS would fail).
		it('announces config.ehloHostname for the bind IP when there is no per-IP override', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			const single = createConfig({
				ehloHostname: 'mail.test.example',
				ehloHostnames: {},
			});

			await sendToMx(createJob(), single, redis, '10.0.0.1');

			expect(pool.acquire).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail.test.example' })
			);
			// Never the OS/container hostname — it has no matching PTR record.
			const opts = vi.mocked(pool.acquire).mock.calls[0]![2] as { name?: string };
			expect(opts.name).not.toBe(osHostname());
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

	// ── PR-25: MTA-STS enforce + multi-MX TLS failover (RFC 8461, RFC 7435) ──
	//
	// Regression-lock for the sender LOOP's TLS-policy handling, complementing
	// the transport-level handshake locks in outboundStartTls.integration.test.ts:
	//  (2) an enforce policy carries requireTLS+rejectUnauthorized into the
	//      acquire AND skips/logs an MX not named in the policy (RFC 8461 §5);
	//  (5) the loop fails over across MX hosts on a transient TLS error (ETLS),
	//      and records a TLS-RPT validation-failure when every MX fails.
	describe('MTA-STS enforce policy is carried into the acquire (PR-25 item 2)', () => {
		it('passes requireTLS:true + tls.rejectUnauthorized:true when the policy enforces', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx1.example.com', 'mx2.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(pool.acquire).toHaveBeenCalledWith(
				'mx1.example.com',
				'10.0.0.1',
				expect.objectContaining({
					requireTLS: true,
					tls: expect.objectContaining({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }),
				})
			);
		});

		it('skips (and logs) an MX host not listed in the enforce policy, delivering via the permitted one', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			// mx1 is NOT in the policy; only mx2 is permitted.
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx2.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			// The disallowed mx1 was never connected to…
			const acquiredHosts = vi.mocked(pool.acquire).mock.calls.map((c) => c[0]);
			expect(acquiredHosts).not.toContain('mx1.example.com');
			expect(acquiredHosts).toContain('mx2.example.com');
			// …and the skip was logged (RFC 8461 §5 — never deliver outside policy).
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.objectContaining({ mxHost: 'mx1.example.com' }),
				expect.stringContaining('not permitted by MTA-STS policy')
			);
		});

		it('all MX hosts excluded by the policy => no acquire, soft bounce (retryable)', async () => {
			// Neither advertised MX is in the policy: every host is skipped, so the
			// loop falls through to a soft bounce rather than delivering off-policy.
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx-elsewhere.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft'); // retryable, not a hard bounce
			expect(pool.acquire).not.toHaveBeenCalled();
		});
	});

	describe('multi-MX TLS failover (PR-25 item 5)', () => {
		// nodemailer raises a STARTTLS upgrade failure as code:'ETLS' with no
		// responseCode — a transient, connection-level error the loop treats as
		// "try the next MX" (RFC 5321 §4.5.4.1).
		const etlsError = { code: 'ETLS', message: 'Error initiating TLS - handshake failure' };

		it('first MX fails with ETLS, second MX resolves => success', async () => {
			mockTransport.sendMail
				.mockRejectedValueOnce(etlsError)
				.mockResolvedValueOnce({ response: '250 OK' });

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(mockTransport.sendMail).toHaveBeenCalledTimes(2); // tried both MX
		});

		it('every MX fails with ETLS => soft bounce (retryable) + TLS-RPT validation-failure recorded', async () => {
			mockTransport.sendMail.mockRejectedValue(etlsError);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft'); // retryable — the job is re-queued
			expect(mockTransport.sendMail).toHaveBeenCalledTimes(2); // both MX attempted

			// Each ETLS attempt records a TLS-RPT validation-failure (RFC 8460 §4)
			// against the recipient domain — not a success, not dropped. With no STS
			// policy in force the result stays the generic 'validation-failure'.
			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(2);
			const details = policy['failure-details']!;
			const validationFailures = details.filter((d) => d['result-type'] === 'validation-failure');
			expect(validationFailures.length).toBe(2);
			// Recorded per MX host, never as 'success'.
			const recordedHosts = validationFailures.map((d) => d['receiving-mx-hostname']);
			expect(recordedHosts).toContain('mx1.example.com');
			expect(recordedHosts).toContain('mx2.example.com');
		});
	});

	// ── PR-35 item 4: MTA-STS enforce flags reach pool.acquire unchanged, an
	// enforce policy skips disallowed MX hosts (RFC 8461 §5), and a requireTLS
	// send with no STARTTLS available soft-bounces rather than failing hard.
	describe('MTA-STS enforce wiring (PR-35)', () => {
		it('forwards enforce requireTLS + rejectUnauthorized to pool.acquire unchanged', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(pool.acquire).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({
					requireTLS: true,
					// rejectUnauthorized + the pinned TLSv1.2 floor both ride in tls.
					tls: expect.objectContaining({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }),
				})
			);
		});

		it('an opportunistic (none) policy forwards requireTLS:false / rejectUnauthorized:false', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			// default mock = policyMode none

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(pool.acquire).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({
					requireTLS: false,
					tls: expect.objectContaining({ rejectUnauthorized: false }),
				})
			);
		});

		it('under enforce, skips an MX host not permitted by the policy and uses the allowed one', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			// mx1 is OFF the allow-list, mx2 (the allowed host) is on it.
			vi.mocked(getMxHostnames).mockResolvedValue(['mx1.attacker.net', 'mx2.example.com']);
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx2.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			// The disallowed MX was never acquired — only the allowed one.
			const acquiredHosts = vi.mocked(pool.acquire).mock.calls.map((c) => c[0]);
			expect(acquiredHosts).not.toContain('mx1.attacker.net');
			expect(acquiredHosts).toContain('mx2.example.com');
		});

		it('under enforce, when ALL MX hosts are disallowed, nothing is acquired and the job soft-bounces for retry', async () => {
			vi.mocked(getMxHostnames).mockResolvedValue(['mx1.attacker.net', 'mx2.attacker.net']);
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mail.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(pool.acquire).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
		});

		it('a requireTLS send to a server with no STARTTLS soft/deferred-bounces (not a hard bounce)', async () => {
			// nodemailer raises a connection-level error (no SMTP responseCode) when a
			// requireTLS transport can't upgrade — the sender treats it as a transient
			// failure: try the next MX, then soft-bounce so the job is re-queued.
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});
			mockTransport.sendMail.mockRejectedValue({
				code: 'ESOCKET',
				message: 'STARTTLS not advertised by server but requireTLS=true',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			// Transient — must be retryable, never a hard (permanent) bounce.
			expect(['soft', 'deferred']).toContain(result.bounceType);
			expect(result.bounceType).not.toBe('hard');
		});
	});

	// ── PR-31: MTA-STS policy context recorded for TLS-RPT (RFC 8460 §3/§4.3/§4.4) ──
	describe('MTA-STS TLS-RPT recording', () => {
		it('records sts-policy-invalid for an enforce policy MX not in the policy (was previously inert)', async () => {
			// Enforce policy whose MX list matches neither mx1 nor mx2 — both are skipped.
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['aspmx.l.google.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			// No allowed MX → delivery cannot proceed (soft bounce), but the policy
			// failure must be reported (this is the bug PR-31 fixes).
			expect(result.success).toBe(false);
			expect(mockTransport.sendMail).not.toHaveBeenCalled();

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			expect(policy.policy['policy-string']).toContain('mode: enforce');
			expect(policy.policy['mx-host']).toEqual(['aspmx.l.google.com']);

			const details = policy['failure-details']!;
			const invalid = details.filter((d) => d['result-type'] === 'sts-policy-invalid');
			expect(invalid.length).toBeGreaterThanOrEqual(1);
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
		});

		it('attributes a cert hostname mismatch under enforce as sts-webpki-invalid', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'], // mx1/mx2.example.com ARE allowed
				policyMode: 'enforce',
			});
			// The verifying connection fails the WebPKI check (no SMTP status code).
			mockTransport.sendMail.mockRejectedValue({
				code: 'ERR_TLS_CERT_ALTNAME_INVALID',
				message: 'Hostname/IP does not match certificate altname',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-webpki-invalid')).toBeDefined();
			// And NOT the generic certificate-host-mismatch type under enforce.
			expect(details.find((d) => d['result-type'] === 'certificate-host-mismatch')).toBeUndefined();
		});

		it('testing mode + STARTTLS-stripping server: records a failure but still delivers', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: false,
				rejectUnauthorized: false,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'testing',
			});
			// First (verifying probe) attempt fails because STARTTLS is stripped;
			// the opportunistic retry on the same MX then succeeds (delivery proceeds).
			mockTransport.sendMail
				.mockRejectedValueOnce({ message: 'STARTTLS not advertised by server' })
				.mockResolvedValueOnce({ response: '250 OK delivered in plaintext' });

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			// Delivery proceeded despite the TLS problem (report-only testing mode).
			expect(result.success).toBe(true);
			expect(mockTransport.sendMail).toHaveBeenCalledTimes(2);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			// A failure was recorded though delivery proceeded. The cleartext retry is
			// NOT a TLS success (PR-24): the STARTTLS-stripping probe and the cleartext
			// retry are BOTH STS-attributed sts-policy-invalid, so no session counts as
			// a TLS success even though the mail was delivered.
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
			expect(policy.summary['total-successful-session-count']).toBe(0);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-policy-invalid')).toBeDefined();
		});
	});

	// ── PR-24: a plaintext delivery is recorded as starttls-not-supported, an
	// encrypted one as success. These sender-level tests drive the secured-state
	// capture by simulating nodemailer's STARTTLS upgrade log on the mock
	// transport; senderPlaintextTlsRpt.integration.test.ts proves the same against
	// a real loopback handshake.
	describe('TLS-RPT records the real session result type per delivery (PR-24)', () => {
		it('records starttls-not-supported (not success) for a cleartext delivery with no policy', async () => {
			// The mock transport never reports a STARTTLS upgrade, so the captured
			// secured state stays false — exactly a plaintext session.
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK in cleartext' });

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true); // delivery still proceeds

			const report = await reportFor();
			const policy = report.policies[0]!;
			// Not counted as a TLS success — overstating coverage is the bug PR-24 fixes.
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(1);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'starttls-not-supported')).toBeDefined();
			expect(details.find((d) => d['result-type'] === 'success')).toBeUndefined();
		});

		it('records a TLS success when the connection negotiated STARTTLS', async () => {
			// Simulate nodemailer's connect-time STARTTLS upgrade log from inside the
			// send so the per-send capture flips to secured.
			mockTransport.sendMail.mockImplementation(async () => {
				securedCaptureLogger.info({ tnx: 'smtp' }, 'Connection upgraded with STARTTLS');
				return { response: '250 OK over TLS' };
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(1);
			expect(policy.summary['total-failure-session-count']).toBe(0);
		});
	});

	// ── T3: DANE at send time (RFC 7672), flag DANE_ENABLED ──────────────────
	//
	// The sender matrix for DANE: flag OFF is byte-identical to T1 (resolver never
	// consulted, no checkServerIdentity on the acquire); with a usable TLSA RRset
	// the acquire requires verified TLS and carries the DANE cert-authentication
	// hook; a TLSA mismatch defers (soft bounce) and records a TLS-RPT
	// validation-failure attributed to the tlsa policy.
	describe('DANE at send time (T3)', () => {
		// The DANE-EE(3) SPKI SHA-256 of the fixture MX certificate — the record the
		// MX would publish at _25._tcp.<mx>.
		const CERT_SPKI_SHA256 = '49fc4a5424807bbbde5617d8b4bb563a79f4566c28d4d9b2e917dddcc7bac89c';
		const MATCHING_TLSA = { usage: 3, selector: 1, matchingType: 1, data: CERT_SPKI_SHA256 };
		const MISMATCH_TLSA = { usage: 3, selector: 1, matchingType: 1, data: 'deadbeef'.repeat(8) };

		/** A minimal PeerCertificate carrying the fixture cert's DER. */
		function fixturePeerCert(): PeerCertificate {
			return { raw: new X509Certificate(MX_CERT).raw } as unknown as PeerCertificate;
		}

		function daneConfig(): MtaConfig {
			return createConfig({ daneEnabled: true, daneResolverUrl: 'https://doh.example/dns-query' });
		}

		it('flag OFF => resolver never consulted; acquire has no DANE hook (byte-identical to T1)', async () => {
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			const tlsOpts = vi.mocked(pool.acquire).mock.calls[0]![2].tls ?? {};
			expect(tlsOpts).not.toHaveProperty('checkServerIdentity');
		});

		it('DANE enabled but no usable TLSA => falls through to the non-DANE path', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).toHaveBeenCalled();
			const tlsOpts = vi.mocked(pool.acquire).mock.calls[0]![2].tls ?? {};
			expect(tlsOpts).not.toHaveProperty('checkServerIdentity');
		});

		it('a TLSA lookup FAILURE (SERVFAIL/outage) defers — never downgrades to non-DANE', async () => {
			// RFC 7672 §2.1: a lookup that could not be completed is not a denial of
			// existence. The sender must defer, not fall through to a (possibly
			// cleartext) non-DANE delivery.
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'DNS RCODE 2',
			});
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			// No delivery attempt at all: we never opened a connection for this MX.
			expect(vi.mocked(pool.acquire)).not.toHaveBeenCalled();
		});

		it('usable TLSA => acquire requires verified TLS and carries the DANE hook', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			mockTransport.sendMail.mockImplementation(async () => {
				securedCaptureLogger.info({ tnx: 'smtp' }, 'Connection upgraded with STARTTLS');
				return { response: '250 OK over DANE TLS' };
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			const opts = vi.mocked(pool.acquire).mock.calls[0]![2];
			expect(opts.requireTLS).toBe(true);
			expect(opts.tls?.rejectUnauthorized).toBe(true);
			expect(typeof opts.tls?.checkServerIdentity).toBe('function');
		});

		it('the DANE hook accepts a matching MX certificate and rejects a mismatch', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			mockTransport.sendMail.mockResolvedValue({ response: '250 OK' });
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			const check = vi.mocked(pool.acquire).mock.calls[0]![2].tls!.checkServerIdentity!;
			// Matching cert → accept (undefined).
			expect(check('mx1.example.com', fixturePeerCert())).toBeUndefined();

			// A wrong TLSA record → the hook returns an Error (aborts the handshake).
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');
			const mismatchCheck = vi.mocked(pool.acquire).mock.calls.at(-1)![2].tls!.checkServerIdentity!;
			const verdict = mismatchCheck('mx1.example.com', fixturePeerCert());
			expect(verdict).toBeInstanceOf(Error);
			expect((verdict as Error).message).toContain('DANE TLSA mismatch');
		});

		it('a TLSA mismatch defers (soft bounce) and records a validation-failure under the tlsa policy', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			// Simulate nodemailer aborting the handshake because our checkServerIdentity
			// returned an Error: a TLS-level failure with no SMTP status code.
			mockTransport.sendMail.mockRejectedValue(
				Object.assign(new Error('DANE TLSA mismatch: MX certificate did not match'), {
					code: 'ERR_TLS_CERT_ALTNAME_INVALID',
				})
			);

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			// No cleartext fallback: the message is deferred for retry.
			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.policy['policy-string']).toContain(`3 1 1 ${MISMATCH_TLSA.data}`);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'validation-failure')).toBeDefined();
		});
	});
});
