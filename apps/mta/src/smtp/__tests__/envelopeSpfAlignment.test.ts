/**
 * Envelope ↔ SPF alignment (PR-68).
 *
 * The MTA builds a VERP bounce envelope: `MAIL FROM: bounce+…@RETURN_PATH_DOMAIN`.
 * Receivers evaluate SPF against the envelope MAIL FROM domain (the return-path
 * domain), NOT the From-domain apex. So with the shipped *shared* bounce domain
 * (`bounces.owlat.com`), the SPF-authenticated identity does NOT align with a
 * customer From-domain (`acme.com`) under DMARC — SPF cannot satisfy DMARC for
 * the From-domain, and DKIM alignment is the only thing carrying it.
 *
 * This test pins:
 *  1. The real envelope.from domain `sendToMx` hands @owlat/smtp-client equals the
 *     configured return-path domain (not the From-domain).
 *  2. `isSpfAligned(envelopeFromDomain, fromDomain, 'relaxed') === false` today
 *     (shared bounce domain) — the structural gap.
 *  3. Under a per-customer return-path subdomain it becomes `true` (the fix).
 *
 * RFC 7208 §2.4 (MAIL FROM is the SPF identity); RFC 7489 §3.1 (DMARC alignment).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { isSpfAligned, emailDomain } from '@owlat/shared/spfAlignment';

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
	pool: {
		acquire: acquireMock,
		release: releaseMock,
		takeConnection: vi.fn().mockResolvedValue(undefined),
		storeConnection: vi.fn(),
		evictConnection: vi.fn(),
	},
	PoolOverCapError: class PoolOverCapError extends Error {},
}));
vi.mock('../mxResolver.js', () => ({
	getMxHostnames: vi.fn().mockResolvedValue(['mx1.acme.com']),
}));
vi.mock('../dkim.js', () => ({
	getDkimOptions: vi.fn().mockResolvedValue(undefined),
}));
// NOTE: buildVerpAddress is intentionally NOT mocked — we want the real
// envelope MAIL FROM address the MTA constructs.
vi.mock('../../queue/groups.js', () => ({
	extractDomain: vi.fn().mockReturnValue('acme.com'),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendToMx } from '../sender.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-001',
		to: 'recipient@acme.com',
		from: 'newsletter@acme.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'acme.com',
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

/** Pull the `envelope.from` the sender handed the SMTP client. */
function capturedEnvelopeFrom(): string {
	const options = sendEnvelopeMock.mock.calls[0]![1] as { from: string };
	return options.from;
}

describe('envelope ↔ SPF alignment', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		vi.clearAllMocks();
		redis = new Redis();
		acquireMock.mockReturnValue({
			key: 'test-key',
			config: { host: 'mx1.acme.com', port: 25, ehloName: 'mail.owlat.com', tlsMode: 'starttls' },
		});
		connectMock.mockResolvedValue({ secured: true, close: vi.fn() });
		sendEnvelopeMock.mockResolvedValue({
			accepted: [],
			rejected: [],
			response: { code: 250, text: '2.0.0 OK', lines: ['2.0.0 OK'] },
		});
		quitMock.mockResolvedValue(undefined);
	});

	it('builds the envelope MAIL FROM on the return-path domain, not the From-domain', async () => {
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const envelopeFrom = capturedEnvelopeFrom();
		// VERP bounce envelope on the configured return-path domain.
		expect(envelopeFrom).toMatch(/^bounce\+.+@bounces\.owlat\.com$/);
		expect(emailDomain(envelopeFrom)).toBe('bounces.owlat.com');
		// The From-domain is different from the SPF-authenticated identity.
		expect(emailDomain(envelopeFrom)).not.toBe(emailDomain(createJob().from));
	});

	it('is NOT SPF-aligned today with the shared bounce domain (the structural gap)', async () => {
		await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');

		const envelopeFromDomain = emailDomain(capturedEnvelopeFrom());
		const fromDomain = emailDomain(createJob().from);

		expect(envelopeFromDomain).toBe('bounces.owlat.com');
		expect(fromDomain).toBe('acme.com');
		// SPF authenticates bounces.owlat.com, which does not align with acme.com
		// under either relaxed or strict mode → SPF cannot satisfy DMARC.
		expect(isSpfAligned(envelopeFromDomain, fromDomain, 'relaxed')).toBe(false);
		expect(isSpfAligned(envelopeFromDomain, fromDomain, 'strict')).toBe(false);
	});

	it('becomes SPF-aligned under a per-customer return-path subdomain (the fix)', async () => {
		// Operator sets RETURN_PATH_DOMAIN to a subdomain of the sending domain.
		const config = createConfig({ returnPathDomain: 'bounce.acme.com' });
		await sendToMx(createJob(), config, redis, '10.0.0.1');

		const envelopeFromDomain = emailDomain(capturedEnvelopeFrom());
		const fromDomain = emailDomain(createJob().from);

		expect(envelopeFromDomain).toBe('bounce.acme.com');
		// Shares the organizational domain with acme.com → aligns under relaxed.
		expect(isSpfAligned(envelopeFromDomain, fromDomain, 'relaxed')).toBe(true);
		// Still not strict-aligned (different exact domains) — relaxed is DMARC's default.
		expect(isSpfAligned(envelopeFromDomain, fromDomain, 'strict')).toBe(false);
	});
});

describe('return-path SPF in the DNS guide', () => {
	it('documents a bounce-domain SPF record for RETURN_PATH_DOMAIN', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const { dirname, resolve } = await import('node:path');
		const here = dirname(fileURLToPath(import.meta.url));
		// apps/mta/src/smtp/__tests__ → repo apps/docs/content/...
		const guidePath = resolve(
			here,
			'../../../../docs/content/3.developer/32.self-hosting-dns-email.md'
		);
		const guide = readFileSync(guidePath, 'utf-8');

		// The guide must show an SPF record published on the bounce/return-path
		// domain (not just the From-domain apex).
		expect(guide).toMatch(/bounces?\.example\.com\.\s+TXT\s+"v=spf1\b[^"]*\ball"/i);
		// And it must explain the return-path is the SPF identity.
		expect(guide).toMatch(/RETURN_PATH_DOMAIN/);
		expect(guide.toLowerCase()).toContain('return-path');
	});
});
