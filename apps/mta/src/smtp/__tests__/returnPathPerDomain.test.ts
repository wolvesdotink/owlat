/**
 * D1 — Per-domain VERP return-path host.
 *
 * A sending domain may register its OWN bounce/return-path host at DKIM
 * registration time (`POST /dkim/{domain}/register` with `{ returnPathHost }`),
 * making the outbound MAIL FROM / VERP bounce domain per-sending-domain instead
 * of the single global `RETURN_PATH_DOMAIN`. This gate locks the whole path:
 *
 *   1. Registration WITH and WITHOUT the override (the register route, driven
 *      real over an ioredis-mock).
 *   2. The send path stamps the per-domain host into the SMTP envelope MAIL FROM
 *      (real `sendToMx` + real `buildVerpAddress`, transport/MX/pool stubbed),
 *      and a bounce DSN addressed to that per-domain host still attributes back
 *      to the exact send (real `parseBounce`/`parseVerpAddress`) — including
 *      under the VERP HMAC — because attribution never covers the host.
 *   3. Legacy registrations (no field, the historic body-less POST) are
 *      unaffected and fall back to the global domain.
 *   4. Failure paths: an invalid/injection hostname is rejected with 400 and
 *      nothing is persisted.
 *
 * Only the transport/MX/pool/DKIM-signing seams and the logger are stubbed;
 * `dkimStore`, `verp`, `parser` and the register route run for real so a drift
 * in any link (store ↔ sender ↔ bounce attribution) fails here.
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

// Transport/MX/DANE/STS seams stubbed exactly like sender.test.ts, so a single
// `attemptSend` succeeds and we can read back the envelope it was handed.
// NOTE: `../../bounce/verp.js` is intentionally NOT mocked — the whole point is
// to exercise the REAL VERP host stamping and the REAL bounce round-trip.
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
// The DKIM routes construct a Convex rotation notifier; stub it so nothing ever
// hits the network (register itself never notifies, but the closure is built).
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn(async () => true),
}));

import { sendToMx } from '../sender.js';
import { createDkimRoutes } from '../../routes/dkim.js';
import * as dkimStore from '../dkimStore.js';
import { buildVerpAddress, parseVerpAddress } from '../../bounce/verp.js';
import { parseBounce } from '../../bounce/parser.js';
import { normalizeReturnPathHost } from '../../lib/returnPathHost.js';
import type { ParsedMessage } from '@owlat/mail-message';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const GLOBAL_RETURN_PATH = 'bounces.owlat.com';

function createConfig(): MtaConfig {
	return {
		apiKey: API_KEY,
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

function authedRegister(
	app: ReturnType<typeof createDkimRoutes>,
	domain: string,
	body?: unknown
): Promise<Response> {
	return app.request(`/${domain}/register`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function createMockDsn(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		text: '',
		subject: '',
		headers: new Map(),
		attachments: [],
		...overrides,
	} as ParsedMessage;
}

describe('D1 — per-domain VERP return-path host', () => {
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
			response: { code: 250, text: '2.0.0 OK <remote@mx>', lines: ['2.0.0 OK <remote@mx>'] },
		});
		delete process.env['BOUNCE_VERP_KEY'];
	});

	afterEach(async () => {
		dkimStore.clearCache();
		await redis.flushall();
		vi.clearAllMocks();
		delete process.env['BOUNCE_VERP_KEY'];
	});

	// ------------------------------------------------------------------
	// 1. Registration — with and without the override.
	// ------------------------------------------------------------------
	describe('registration endpoint', () => {
		it('registers WITHOUT the override — domain has no per-domain host (global fallback)', async () => {
			const app = createDkimRoutes(redis, createConfig());

			// Body-less POST — exactly the historic MtaIdentityManager call shape.
			const res = await authedRegister(app, 'acme.com');
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				success: boolean;
				selector: string;
				returnPathHost?: string;
			};
			expect(json.success).toBe(true);
			expect(json.selector).toBeTruthy();
			// No returnPathHost echoed when none was set.
			expect(json.returnPathHost).toBeUndefined();

			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBeNull();
		});

		it('registers WITH a valid override — stores and echoes the normalized host', async () => {
			const app = createDkimRoutes(redis, createConfig());

			const res = await authedRegister(app, 'acme.com', { returnPathHost: 'Bounce.ACME.com' });
			expect(res.status).toBe(200);
			const json = (await res.json()) as { success: boolean; returnPathHost?: string };
			// Normalized to lower-case on the way in.
			expect(json.returnPathHost).toBe('bounce.acme.com');

			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBe('bounce.acme.com');
		});

		it('sets the override even when the DKIM key already exists (idempotent key, updatable host)', async () => {
			const app = createDkimRoutes(redis, createConfig());

			// First registration WITHOUT a host generates the domain's real DKIM key.
			const first = await authedRegister(app, 'acme.com');
			expect(first.status).toBe(200);
			const firstJson = (await first.json()) as { selector: string; returnPathHost?: string };
			expect(firstJson.returnPathHost).toBeUndefined();
			const originalSelector = firstJson.selector;

			// A LATER registration adds the return-path host. The key is idempotent
			// (same selector, not clobbered) but the host is applied.
			const res = await authedRegister(app, 'acme.com', { returnPathHost: 'bounce.acme.com' });
			expect(res.status).toBe(200);
			const json = (await res.json()) as { selector: string; returnPathHost?: string };
			expect(json.selector).toBe(originalSelector);
			expect(json.returnPathHost).toBe('bounce.acme.com');

			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBe('bounce.acme.com');
			// And the active DKIM key is untouched.
			expect((await dkimStore.getDkimConfig(redis, 'acme.com'))?.selector).toBe(originalSelector);
		});

		it('rejects an invalid hostname with 400 and persists nothing', async () => {
			const app = createDkimRoutes(redis, createConfig());

			const res = await authedRegister(app, 'acme.com', {
				returnPathHost: 'bounce acme.com; rm -rf /',
			});
			expect(res.status).toBe(400);
			const json = (await res.json()) as { error: string };
			expect(json.error).toMatch(/valid DNS hostname/i);

			// Neither the key nor a return-path host was written.
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBeNull();
			expect(await dkimStore.hasDkimKey(redis, 'acme.com')).toBe(false);
		});

		it('explicit null clears an existing override (revert to global)', async () => {
			const app = createDkimRoutes(redis, createConfig());

			// Set an override first.
			const set = await authedRegister(app, 'acme.com', { returnPathHost: 'bounce.acme.com' });
			expect(set.status).toBe(200);
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBe('bounce.acme.com');

			// Now clear it with an explicit null.
			const cleared = await authedRegister(app, 'acme.com', { returnPathHost: null });
			expect(cleared.status).toBe(200);
			const json = (await cleared.json()) as { returnPathHost?: string };
			// No host echoed once cleared.
			expect(json.returnPathHost).toBeUndefined();

			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBeNull();
		});

		it('null on a domain with no override is a harmless no-op (200, still no host)', async () => {
			const app = createDkimRoutes(redis, createConfig());
			const res = await authedRegister(app, 'acme.com', { returnPathHost: null });
			expect(res.status).toBe(200);
			const json = (await res.json()) as { returnPathHost?: string };
			expect(json.returnPathHost).toBeUndefined();
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBeNull();
		});

		it('a body-less POST (historic call) is treated as "no override", not an error', async () => {
			const app = createDkimRoutes(redis, createConfig());
			const res = await authedRegister(app, 'acme.com');
			expect(res.status).toBe(200);
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'acme.com')).toBeNull();
		});

		it('a malformed JSON body is a 400, not a silent "no override"', async () => {
			const app = createDkimRoutes(redis, createConfig());
			const res = await app.request('/acme.com/register', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: '{ "returnPathHost": "bounce.acme.com"', // truncated / invalid JSON
			});
			expect(res.status).toBe(400);
			const json = (await res.json()) as { error: string };
			expect(json.error).toMatch(/valid JSON/i);

			// Nothing was registered on the malformed request.
			dkimStore.clearCache();
			expect(await dkimStore.hasDkimKey(redis, 'acme.com')).toBe(false);
		});

		it.each([
			['bare null', 'null'],
			['scalar number', '42'],
			['scalar string', '"bounce.acme.com"'],
			['array', '["bounce.acme.com"]'],
		])('rejects a well-formed but non-object JSON body (%s) with 400', async (_label, rawBody) => {
			const app = createDkimRoutes(redis, createConfig());
			const res = await app.request('/acme.com/register', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: rawBody,
			});
			expect(res.status).toBe(400);
			const json = (await res.json()) as { error: string };
			expect(json.error).toMatch(/JSON object/i);

			// Nothing was registered on the rejected request.
			dkimStore.clearCache();
			expect(await dkimStore.hasDkimKey(redis, 'acme.com')).toBe(false);
		});

		it('requires the master key', async () => {
			const app = createDkimRoutes(redis, createConfig());
			const res = await app.request('/acme.com/register', { method: 'POST' });
			expect(res.status).toBe(401);
		});
	});

	// ------------------------------------------------------------------
	// 2. Bounce routing uses the per-domain host.
	// ------------------------------------------------------------------
	describe('send path stamps the per-domain host into MAIL FROM', () => {
		function envelopeFrom(): string {
			const envelope = sendEnvelopeMock.mock.calls[0]?.[1] as { from: string };
			return envelope.from;
		}

		it('uses the per-domain host for the VERP MAIL FROM when one is registered', async () => {
			await dkimStore.setReturnPathHost(redis, 'acme.com', 'bounce.acme.com');
			dkimStore.clearCache();

			const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const from = envelopeFrom();
			expect(from.endsWith('@bounce.acme.com')).toBe(true);
			expect(from).not.toContain(GLOBAL_RETURN_PATH);
			expect(from.startsWith('bounce+')).toBe(true);
		});

		it('falls back to the global RETURN_PATH_DOMAIN when the domain has no override', async () => {
			const result = await sendToMx(createJob(), createConfig(), redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const from = envelopeFrom();
			expect(from.endsWith(`@${GLOBAL_RETURN_PATH}`)).toBe(true);
		});

		it('a DSN arriving at the per-domain host still attributes back to the send', async () => {
			process.env['BOUNCE_VERP_KEY'] = 'return-path-test-verp-key-0123456789';
			await dkimStore.setReturnPathHost(redis, 'acme.com', 'bounce.acme.com');
			dkimStore.clearCache();

			await sendToMx(createJob({ messageId: 'send_xyz789' }), createConfig(), redis, '10.0.0.1');
			const verpRecipient = envelopeFrom();
			expect(verpRecipient.endsWith('@bounce.acme.com')).toBe(true);

			// The remote MTA bounces to that per-domain VERP envelope. parseBounce
			// must decode the SAME messageId back out even though the host is the
			// per-domain one, not the global bounce domain — attribution is
			// host-agnostic.
			const dsn = createMockDsn({
				subject: 'Delivery Status Notification (Failure)',
				from: { text: 'MAILER-DAEMON@mx1.example.com' } as ParsedMessage['from'],
				text: [
					'Final-Recipient: rfc822; user@remote.test',
					'Action: failed',
					'Status: 5.1.1',
					'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
				].join('\n'),
			});
			const classification = parseBounce(dsn, [], verpRecipient);
			expect(classification?.originalMessageId).toBe('send_xyz789');
		});

		it('per-domain host attribution survives the VERP HMAC (signed mode)', async () => {
			process.env['BOUNCE_VERP_KEY'] = 'return-path-test-verp-key-0123456789';
			await dkimStore.setReturnPathHost(redis, 'acme.com', 'bounce.acme.com');
			dkimStore.clearCache();

			await sendToMx(createJob({ messageId: 'send_signed1' }), createConfig(), redis, '10.0.0.1');
			const verpRecipient = envelopeFrom();
			expect(verpRecipient.endsWith('@bounce.acme.com')).toBe(true);

			// The signed token verifies and decodes regardless of the host — the MAC
			// is computed over the id + time window only, never the domain.
			expect(parseVerpAddress(verpRecipient)).toBe('send_signed1');
		});
	});

	// ------------------------------------------------------------------
	// 3. Legacy registrations unaffected.
	// ------------------------------------------------------------------
	describe('legacy registrations', () => {
		it('a domain registered before the field existed resolves to the global host', async () => {
			// Simulate a legacy record: a DKIM key with NO returnPathHost field.
			await dkimStore.setDkimKey(
				redis,
				'legacy.com',
				's1',
				'-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----'
			);
			dkimStore.clearCache();

			expect(await dkimStore.getReturnPathHost(redis, 'legacy.com')).toBeNull();

			const from = buildVerpAddress(
				'send_legacy',
				(await dkimStore.getReturnPathHost(redis, 'legacy.com')) ?? GLOBAL_RETURN_PATH
			);
			expect(from.endsWith(`@${GLOBAL_RETURN_PATH}`)).toBe(true);
		});

		it('removing a domain clears its return-path host', async () => {
			await dkimStore.setDkimKey(
				redis,
				'gone.com',
				's1',
				'-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----'
			);
			await dkimStore.setReturnPathHost(redis, 'gone.com', 'bounce.gone.com');
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'gone.com')).toBe('bounce.gone.com');

			await dkimStore.removeDkimKey(redis, 'gone.com');
			dkimStore.clearCache();
			expect(await dkimStore.getReturnPathHost(redis, 'gone.com')).toBeNull();
		});
	});

	// ------------------------------------------------------------------
	// 4. Hostname validation — failure paths.
	// ------------------------------------------------------------------
	describe('returnPathHost validation', () => {
		it('accepts valid FQDNs (normalized to lower-case, trailing dot stripped)', () => {
			expect(normalizeReturnPathHost('bounce.acme.com')).toBe('bounce.acme.com');
			expect(normalizeReturnPathHost('  Mail.Sub.Example.CO.UK ')).toBe('mail.sub.example.co.uk');
			expect(normalizeReturnPathHost('bounces.example.com.')).toBe('bounces.example.com');
			expect(normalizeReturnPathHost('a-b.example.io')).toBe('a-b.example.io');
		});

		it('accepts punycode / IDN TLDs (must not diverge from the shared validator)', () => {
			// A host that passes the shared DNS-hostname validator (which D2 uses)
			// must not 400 here, so an alphabetic-only TLD rule is wrong.
			expect(normalizeReturnPathHost('bounce.example.xn--p1ai')).toBe('bounce.example.xn--p1ai');
			expect(normalizeReturnPathHost('mail.xn--80akhbyknj4f')).toBe('mail.xn--80akhbyknj4f');
			// Digits are allowed inside a TLD label as long as it is not ALL digits.
			expect(normalizeReturnPathHost('bounce.example.a1')).toBe('bounce.example.a1');
		});

		it.each([
			['empty', ''],
			['whitespace only', '   '],
			['single label (no TLD)', 'localhost'],
			['all-numeric TLD', 'bounce.example.123'],
			['bare IPv4 literal (all-numeric last label)', '10.0.0.5'],
			['interior whitespace', 'bounce example.com'],
			['contains @', 'bounce@acme.com'],
			['contains a scheme', 'http://bounce.acme.com'],
			['contains a path', 'bounce.acme.com/x'],
			['contains a port', 'bounce.acme.com:25'],
			['leading hyphen label', '-bounce.acme.com'],
			['trailing hyphen label', 'bounce-.acme.com'],
			['double dot', 'bounce..acme.com'],
			['leading dot', '.bounce.acme.com'],
			['shell injection', 'bounce.acme.com; rm -rf /'],
			['newline injection', 'bounce.acme.com\nMAIL FROM:<x>'],
			['null byte', 'bounce.acme.com\x00'],
			['underscore', 'bounce_acme.com'],
			['non-string', 42],
			['label over 63 chars', `${'a'.repeat(64)}.com`],
		])('rejects %s', (_label, value) => {
			expect(normalizeReturnPathHost(value)).toBeNull();
		});

		it('rejects a host longer than 253 octets', () => {
			const longHost = `${Array.from({ length: 20 }, () => 'label').join('.')}.example.com`;
			// Build one that is definitely > 253 chars.
			const tooLong = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`;
			expect(tooLong.length).toBeGreaterThan(253);
			expect(normalizeReturnPathHost(tooLong)).toBeNull();
			// A merely-long-but-valid host is fine.
			expect(normalizeReturnPathHost(longHost)).toBe(longHost);
		});
	});
});
