/**
 * Bounce listener tarpit exemption.
 *
 * The listener binds dual-stack, so an IPv4 peer on the Docker bridge arrives
 * as `::ffff:172.17.x.x`. The old prefix check only knew `172.16.` and no mapped
 * private range, so container-to-container bounce traffic was tarpitted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../inboundSecurity.js', () => ({
	checkConnectionRateLimit: vi.fn(async () => true),
	releaseConnection: vi.fn(async () => undefined),
}));

import type Redis from 'ioredis';
import { buildOnConnect } from '../server.js';
import type { MtaConfig } from '../../config.js';

const TARPIT_MS = 60_000;

const config = {
	bounceTarpitEnabled: true,
	bounceTarpitDelayMs: TARPIT_MS,
	bounceMaxConnectionsPerIp: 10,
} as unknown as MtaConfig;

/** Resolves true when onConnect finished without the tarpit delay elapsing. */
async function admittedWithoutDelay(remoteAddress: string): Promise<boolean> {
	const onConnect = buildOnConnect(
		config,
		{} as Redis,
		() => undefined,
		() => false
	);
	let settled = false;
	const pending = onConnect({ remoteAddress } as Parameters<typeof onConnect>[0]).then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(TARPIT_MS - 1);
	const early = settled;
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	return early;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('bounce onConnect tarpit', () => {
	it.each([
		'127.0.0.1',
		'::1',
		'::ffff:127.0.0.1',
		'10.1.2.3',
		'::ffff:10.0.0.1',
		'172.17.0.2',
		'::ffff:172.17.0.2',
		'172.31.0.9',
		'192.168.1.20',
		'::ffff:192.168.1.20',
	])('exempts the internal peer %s', async (ip) => {
		expect(await admittedWithoutDelay(ip)).toBe(true);
	});

	it.each(['203.0.113.10', '::ffff:203.0.113.10', '172.32.0.1', '2001:db8::25'])(
		'tarpits the external peer %s',
		async (ip) => {
			expect(await admittedWithoutDelay(ip)).toBe(false);
		}
	);
});
