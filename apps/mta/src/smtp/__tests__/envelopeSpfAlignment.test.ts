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
		attachConnection: vi.fn().mockReturnValue(true),
		evictConnection: vi.fn(),
	},
	PoolOverCapError: class PoolOverCapError extends Error {},
}));
vi.mock('../mxResolver.js', () => ({
	resolveMxDestination: vi.fn().mockResolvedValue({
		status: 'deliverable',
		source: 'mx',
		hosts: [{ exchange: 'mx1.acme.com', priority: 0 }],
	}),
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
import { createOwlatHostConfig as createConfig } from '../../__tests__/helpers/fixtures.js';

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
