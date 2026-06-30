import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { findRoute, createRoute } from '../router.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Parity / regression suite for routing a recipient through the shared
 * `parseAddress` (instead of a raw `split('@')`). The representative inputs
 * — plain address, mixed-case, "Name <addr>" framing, and non-addresses —
 * must keep resolving to the same route the raw split produced for valid
 * addresses, while the display-name form now unwraps correctly.
 */
describe('findRoute address parsing parity', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		await createRoute(redis, { domain: 'acme.com', address: 'support', mode: 'accept' });
	});

	it('resolves a plain lowercase recipient', async () => {
		const route = await findRoute(redis, 'support@acme.com');
		expect(route?.address).toBe('support');
	});

	it('lowercases a mixed-case recipient', async () => {
		const route = await findRoute(redis, 'SUPPORT@ACME.COM');
		expect(route?.address).toBe('support');
	});

	it('unwraps a "Name <addr>" recipient (a raw split would keep the bracket)', async () => {
		const route = await findRoute(redis, 'Support Team <support@acme.com>');
		expect(route?.address).toBe('support');
	});

	it('returns null for a non-address recipient', async () => {
		expect(await findRoute(redis, 'not-an-email')).toBeNull();
	});

	it('returns null for an empty recipient', async () => {
		expect(await findRoute(redis, '')).toBeNull();
	});
});
