/**
 * MX / bounce listener policy hooks — SPF gate, inbound-TLS gate, RCPT gate.
 *
 * The port-25 listener runs on the in-house `@owlat/smtp-listener` (replacing
 * `smtp-server`). Its policy lives in exported hook factories on `server.ts`, so
 * these tests exercise the REAL `buildOnMailFrom` / `buildOnRcptTo` closures
 * directly (no socket), asserting the structured {@link SmtpReply} each returns —
 * `undefined` accepts, a `>= 400` reply rejects.
 *
 * Covered:
 *   - RFC 5321 §4.5.5 / RFC 3464: a genuine DSN uses the NULL reverse-path
 *     (`MAIL FROM:<>`, surfaced as the empty address) — SPF is NOT consulted.
 *   - RFC 7208 §8.4: a non-empty MAIL FROM that SPF-fails is rejected.
 *   - The dynamic inbound-TLS gate rejects a plaintext transaction.
 *   - The RCPT gate accepts the TLS-RPT rua system route and refuses an unrouted
 *     recipient `550`, and refuses an over-quota mailbox with the structured
 *     `552 5.2.2` (the sanctioned correction of the pre-cutover `550 552 5.2.2`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Spy on the SPF checker so we can both observe whether it ran and steer its
// verdict. `checkSpf` lives in `@owlat/mail-auth` (Own-the-Inbound A1); only it
// is overridden — the rest keep their real (here-unused) implementations.
vi.mock('@owlat/mail-auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/mail-auth')>();
	return { ...actual, checkSpf: vi.fn() };
});

// Personal-mailbox lookup is a Redis cache read; stub it so each test steers the
// RCPT path. `findRoute` itself stays real (the TLS-RPT system route lives there).
vi.mock('../../inbound/mailboxResolver.js', () => ({
	findMailboxRoute: vi.fn(async () => null),
}));

vi.mock('../../inbound/inboundTlsPolicy.js', () => ({
	isInboundTlsRequired: vi.fn(async () => true),
	inboundTlsRequiredReply: () => ({
		code: 550,
		enhanced: '5.7.10',
		text: 'Encryption needed: this server requires STARTTLS for inbound delivery',
	}),
}));

import type Redis from 'ioredis';
import type { SmtpAddress, SmtpSession, SmtpReply } from '@owlat/smtp-listener';
import { buildOnMailFrom, buildOnRcptTo } from '../server.js';
import { checkSpf } from '@owlat/mail-auth';
import { findMailboxRoute } from '../../inbound/mailboxResolver.js';
import { isInboundTlsRequired } from '../../inbound/inboundTlsPolicy.js';
import type { MtaConfig } from '../../config.js';

/** Minimal MtaConfig — only the fields the hooks read. */
function makeConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		ehloHostname: 'mx.owlat.test',
		inboundSpfEnabled: true,
		bounceMaxClients: 100,
		bounceMaxConnectionsPerIp: 10,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 0,
		...overrides,
	} as unknown as MtaConfig;
}

const fakeRedis = { get: async () => null } as unknown as Redis;
const authResolvers = { spf: {}, dkim: {}, dmarcTxt: {}, arc: {} } as never;

/** A minimal listener session carrying the fields the hooks consult. */
function makeSession(secure = true): SmtpSession<unknown, { spfResult?: string }> {
	return {
		id: 't-1',
		remoteAddress: '203.0.113.10',
		remotePort: 12345,
		localAddress: '198.51.100.1',
		localPort: 25,
		secure,
		authenticated: false,
		esmtp: true,
		clientHostname: 'sender.example.com',
		rcptTo: [],
		state: undefined,
	} as unknown as SmtpSession<unknown, { spfResult?: string }>;
}

function addr(address: string): SmtpAddress {
	return { address, params: {} };
}

/** Run `onMailFrom` and resolve with the reply it returned (or undefined). */
async function runMailFrom(
	config: MtaConfig,
	envelopeFrom: string,
	secure = true
): Promise<SmtpReply | void> {
	const onMailFrom = buildOnMailFrom(config, fakeRedis, authResolvers);
	// `BounceSession`/`BounceTransaction` aren't exported; borrow the handler's own
	// parameter type so the test session matches the (non-public) transaction shape.
	return onMailFrom(addr(envelopeFrom), makeSession(secure) as Parameters<typeof onMailFrom>[1]);
}

describe('bounce onMailFrom inbound TLS gate', () => {
	beforeEach(() => {
		vi.mocked(isInboundTlsRequired).mockReset().mockResolvedValue(true);
	});

	it('rejects plaintext before accepting the SMTP transaction', async () => {
		const reply = await runMailFrom(
			makeConfig({ inboundSpfEnabled: false }),
			'sender@example.com',
			false
		);
		expect(reply?.code).toBe(550);
		expect(reply?.enhanced).toBe('5.7.10');
		expect(String(reply?.text)).toContain('Encryption needed');
	});

	it('accepts a TLS-upgraded transaction when the policy is enabled', async () => {
		const reply = await runMailFrom(makeConfig({ inboundSpfEnabled: false }), 'sender@example.com');
		expect(reply).toBeUndefined();
	});

	it('accepts plaintext only after the policy is explicitly disabled', async () => {
		vi.mocked(isInboundTlsRequired).mockResolvedValue(false);
		const reply = await runMailFrom(
			makeConfig({ inboundSpfEnabled: false }),
			'sender@example.com',
			false
		);
		expect(reply).toBeUndefined();
	});
});

describe('bounce onMailFrom SPF gate (PR-74)', () => {
	beforeEach(() => {
		vi.mocked(checkSpf).mockReset();
		vi.mocked(isInboundTlsRequired).mockReset().mockResolvedValue(true);
	});

	it('accepts an empty MAIL FROM ("") without consulting SPF (null sender)', async () => {
		const reply = await runMailFrom(makeConfig(), '');
		expect(reply).toBeUndefined();
		expect(checkSpf).not.toHaveBeenCalled();
	});

	it('accepts an explicit "<>" MAIL FROM without consulting SPF (null sender)', async () => {
		const reply = await runMailFrom(makeConfig(), '<>');
		expect(reply).toBeUndefined();
		expect(checkSpf).not.toHaveBeenCalled();
	});

	it('rejects a non-empty MAIL FROM that SPF-fails (RFC 7208 §8.4)', async () => {
		vi.mocked(checkSpf).mockResolvedValue({ result: 'fail', explanation: 'not authorized' });
		const reply = await runMailFrom(makeConfig(), 'spoofer@evil.test');
		expect(checkSpf).toHaveBeenCalledTimes(1);
		expect(reply?.code).toBe(550);
		expect(String(reply?.text)).toMatch(/SPF/i);
	});

	it('accepts a non-empty MAIL FROM that SPF-passes', async () => {
		vi.mocked(checkSpf).mockResolvedValue({ result: 'pass' });
		const reply = await runMailFrom(makeConfig(), 'legit@sender.example.com');
		expect(checkSpf).toHaveBeenCalledTimes(1);
		expect(reply).toBeUndefined();
	});

	it('skips SPF entirely (even for a real sender) when inboundSpfEnabled is false', async () => {
		const reply = await runMailFrom(
			makeConfig({ inboundSpfEnabled: false }),
			'whoever@anywhere.test'
		);
		expect(reply).toBeUndefined();
		expect(checkSpf).not.toHaveBeenCalled();
	});
});

// ─── RCPT gate — TLS-RPT rua system route + quota ─────────────────────────────

/** Run `onRcptTo` and resolve with the reply it returned (or undefined). */
async function runRcptTo(config: MtaConfig, rcptTo: string): Promise<SmtpReply | void> {
	const onRcptTo = buildOnRcptTo(config, fakeRedis);
	return onRcptTo(addr(rcptTo));
}

describe('bounce onRcptTo — TLS-RPT rua system route', () => {
	const RUA = 'tls-reports@owlat.test';
	const tlsRptConfig = makeConfig({
		tlsRptRua: `mailto:${RUA}`,
		convexSiteUrl: 'https://acme.convex.site',
		webhookSecret: 'mta-test-secret',
	});

	beforeEach(() => {
		vi.mocked(findMailboxRoute).mockReset().mockResolvedValue(null);
	});

	it('accepts RCPT TO the configured rua address (delivers to the system webhook)', async () => {
		const reply = await runRcptTo(tlsRptConfig, RUA);
		expect(reply).toBeUndefined();
	});

	it('still rejects an unrelated, unrouted recipient with "Mailbox not found"', async () => {
		const reply = await runRcptTo(tlsRptConfig, 'nobody@nowhere.test');
		expect(reply?.code).toBe(550);
		expect(String(reply?.text)).toMatch(/Mailbox not found/i);
	});
});

describe('bounce onRcptTo — mailbox quota (structured 552 5.2.2, sanctioned)', () => {
	beforeEach(() => {
		vi.mocked(findMailboxRoute).mockReset();
	});

	it('refuses an over-quota mailbox with 552 5.2.2 (was the malformed 550 552 5.2.2)', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValue({
			organizationId: 'org_1',
			recipientAddress: 'full@org.example',
			quotaBytes: 100,
			usedBytes: 100,
		} as never);
		const reply = await runRcptTo(makeConfig(), 'full@org.example');
		expect(reply?.code).toBe(552);
		expect(reply?.enhanced).toBe('5.2.2');
		expect(String(reply?.text)).toMatch(/quota/i);
	});

	it('accepts a mailbox under quota', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValue({
			organizationId: 'org_1',
			recipientAddress: 'ok@org.example',
			quotaBytes: 1000,
			usedBytes: 10,
		} as never);
		const reply = await runRcptTo(makeConfig(), 'ok@org.example');
		expect(reply).toBeUndefined();
	});

	it('always accepts a VERP bounce+ recipient without a mailbox/route lookup', async () => {
		const spy = vi.mocked(findMailboxRoute).mockResolvedValue(null);
		const reply = await runRcptTo(makeConfig(), 'bounce+abc@bounces.owlat.test');
		expect(reply).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});
});
