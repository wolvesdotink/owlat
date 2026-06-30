/**
 * Bounce SMTP server `onMailFrom` SPF gate — audit PR-74 (2).
 *
 * RFC 5321 §4.5.5 / RFC 3464: a genuine delivery-status notification is sent
 * with the NULL reverse-path (`MAIL FROM:<>`). Anyone may submit such a DSN, so
 * SPF cannot meaningfully authenticate an empty return-path — `onMailFrom` MUST
 * accept it without consulting SPF. A NON-empty MAIL FROM, however, IS an
 * identity claim: when `inboundSpfEnabled` and SPF returns `fail` the
 * transaction must be rejected (RFC 7208 §8.4).
 *
 * These tests reach the real `onMailFrom` closure off `server.options`
 * (smtp-server stores the handlers there), with `checkSpf` spied so we can
 * assert it is NOT called for the null sender and IS the gate for a real one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Spy on the SPF checker so we can both observe whether it ran and steer its
// verdict. Only `checkSpf` is overridden; the rate-limit helpers keep their real
// (here-unused) implementations.
vi.mock('../inboundSecurity.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../inboundSecurity.js')>();
	return { ...actual, checkSpf: vi.fn() };
});

import type Redis from 'ioredis';
import type { SMTPServerAddress, SMTPServerSession } from 'smtp-server';
import { createBounceServer } from '../server.js';
import { checkSpf } from '../inboundSecurity.js';
import type { MtaConfig } from '../../config.js';

/** Minimal MtaConfig — only the fields `createBounceServer`/`onMailFrom` read. */
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

/** Pull the (typed) `onMailFrom` handler out of the constructed server. */
function getOnMailFrom(config: MtaConfig) {
	const server = createBounceServer(config, {} as unknown as Redis);
	const handler = (server.options as { onMailFrom?: unknown }).onMailFrom;
	if (typeof handler !== 'function') throw new Error('onMailFrom not registered');
	return handler as (
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null) => void,
	) => void;
}

function makeSession(): SMTPServerSession {
	return {
		remoteAddress: '203.0.113.10',
		hostNameAppearsAs: 'sender.example.com',
	} as unknown as SMTPServerSession;
}

/** Run `onMailFrom` and resolve with the error (if any) passed to its callback. */
function runMailFrom(
	config: MtaConfig,
	envelopeFrom: string,
): Promise<Error | null | undefined> {
	const onMailFrom = getOnMailFrom(config);
	return new Promise((resolve) => {
		onMailFrom(
			{ address: envelopeFrom } as SMTPServerAddress,
			makeSession(),
			(err) => resolve(err),
		);
	});
}

describe('bounce server onMailFrom SPF gate (PR-74)', () => {
	beforeEach(() => {
		vi.mocked(checkSpf).mockReset();
	});

	it('accepts an empty MAIL FROM ("") without consulting SPF (null sender)', async () => {
		const err = await runMailFrom(makeConfig(), '');
		expect(err == null).toBe(true);
		// A genuine DSN uses the null reverse-path — SPF must NOT be evaluated.
		expect(checkSpf).not.toHaveBeenCalled();
	});

	it('accepts an explicit "<>" MAIL FROM without consulting SPF (null sender)', async () => {
		const err = await runMailFrom(makeConfig(), '<>');
		expect(err == null).toBe(true);
		expect(checkSpf).not.toHaveBeenCalled();
	});

	it('rejects a non-empty MAIL FROM that SPF-fails (RFC 7208 §8.4)', async () => {
		vi.mocked(checkSpf).mockResolvedValue({ result: 'fail', explanation: 'not authorized' });
		const err = await runMailFrom(makeConfig(), 'spoofer@evil.test');
		expect(checkSpf).toHaveBeenCalledTimes(1);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/SPF/i);
	});

	it('accepts a non-empty MAIL FROM that SPF-passes', async () => {
		vi.mocked(checkSpf).mockResolvedValue({ result: 'pass' });
		const err = await runMailFrom(makeConfig(), 'legit@sender.example.com');
		expect(checkSpf).toHaveBeenCalledTimes(1);
		expect(err == null).toBe(true);
	});

	it('skips SPF entirely (even for a real sender) when inboundSpfEnabled is false', async () => {
		const err = await runMailFrom(makeConfig({ inboundSpfEnabled: false }), 'whoever@anywhere.test');
		expect(err == null).toBe(true);
		expect(checkSpf).not.toHaveBeenCalled();
	});
});
