/**
 * The per-IP connection limiter both MTA listeners hand to
 * `@owlat/smtp-listener` as `admission.perIp`. The listener owns the admission
 * flow and the exactly-once release (tested in the package); this suite pins
 * the Redis counter itself: the limit, the key names and TTL that must survive
 * a rolling deploy, and the single-script shape that never leaves an untimed
 * key behind on a `noeviction` Redis.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createConnectionLimiter } from '../connectionSlots.js';

const peer = (remoteAddress: string) => ({ remoteAddress });

let redis: RealRedis;

beforeEach(() => {
	redis = new Redis() as unknown as RealRedis;
});

afterEach(async () => {
	await redis.flushall();
});

describe.each([
	{ listener: 'bounce', prefix: 'mta:bounce:conn:' },
	{ listener: 'submission', prefix: 'mta:submission:conn:' },
])('createConnectionLimiter ($listener prefix)', ({ prefix }) => {
	const limiter = (max: number, r: RealRedis = redis) =>
		createConnectionLimiter(r, prefix, 300, max);
	const count = async (ip: string): Promise<string | null> => redis.get(`${prefix}${ip}`);

	it('allows up to the per-IP max, then refuses', async () => {
		const l = limiter(5);
		for (let i = 0; i < 5; i++) expect(await l.acquire(peer('1.2.3.4'))).toBe(true);
		expect(await l.acquire(peer('1.2.3.4'))).toBe(false);
		expect(await count('1.2.3.4')).toBe('5');
	});

	it('tracks IPs independently', async () => {
		const l = limiter(3);
		for (let i = 0; i < 3; i++) await l.acquire(peer('1.2.3.4'));
		expect(await l.acquire(peer('5.6.7.8'))).toBe(true);
	});

	it('keys an IPv4-mapped peer on its plain IPv4 address', async () => {
		const l = limiter(10);
		await l.acquire(peer('::ffff:1.2.3.4'));
		await l.acquire(peer('1.2.3.4'));
		expect(await count('1.2.3.4')).toBe('2');
	});

	it('keeps the counter window at the configured TTL', async () => {
		await limiter(5).acquire(peer('1.2.3.4'));
		const ttl = await redis.ttl(`${prefix}1.2.3.4`);
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(300);
	});

	it('frees a slot on release, and removes the key at zero', async () => {
		const l = limiter(2);
		await l.acquire(peer('1.2.3.4'));
		await l.acquire(peer('1.2.3.4'));
		expect(await l.acquire(peer('1.2.3.4'))).toBe(false);

		await l.release(peer('1.2.3.4'));
		expect(await count('1.2.3.4')).toBe('1');
		expect(await l.acquire(peer('1.2.3.4'))).toBe(true);

		await l.release(peer('1.2.3.4'));
		await l.release(peer('1.2.3.4'));
		expect(await redis.exists(`${prefix}1.2.3.4`)).toBe(0);
	});

	it('nets a refused connection back without going below the live count', async () => {
		const l = limiter(1);
		await l.acquire(peer('8.8.8.8'));
		expect(await l.acquire(peer('8.8.8.8'))).toBe(false);
		// The refusal undid its own increment inside the same script.
		expect(await count('8.8.8.8')).toBe('1');
	});

	it('has no second round trip left to fault after the increment lands', async () => {
		// The old shape was INCR then EXPIRE. An EXPIRE that faulted left the
		// counter with no expiry, and the compensating DECR left it at zero rather
		// than removing it: a permanent key for any IP that connected during a
		// Redis blip.
		(redis as unknown as { expire: RealRedis['expire'] }).expire = (() => {
			throw new Error('redis expire failed');
		}) as RealRedis['expire'];

		expect(await limiter(5).acquire(peer('9.9.9.9'))).toBe(true);
		expect(await redis.ttl(`${prefix}9.9.9.9`)).toBeGreaterThan(0);
	});

	it('leaves nothing behind when the counter write faults', async () => {
		// The listener fails open on a throw and owes no release, so a fault must
		// not leave a dangling increment that leaks a slot until the TTL.
		const broken = {
			eval: vi.fn().mockRejectedValue(new Error('redis unreachable')),
		} as unknown as RealRedis;

		await expect(limiter(1, broken).acquire(peer('9.9.9.9'))).rejects.toThrow();

		expect(await redis.exists(`${prefix}9.9.9.9`)).toBe(0);
		expect(await limiter(1).acquire(peer('9.9.9.9'))).toBe(true);
	});

	/**
	 * The counter is named after an unauthenticated peer's IP, and Redis runs
	 * `maxmemory-policy noeviction`, so an untimed one is a key that never goes
	 * away on an instance that refuses writes at its cap.
	 */
	it('heals a legacy untimed counter on the next connection', async () => {
		await redis.set(`${prefix}5.5.5.5`, '3');
		expect(await redis.ttl(`${prefix}5.5.5.5`)).toBe(-1);

		await limiter(10).acquire(peer('5.5.5.5'));

		expect(await redis.ttl(`${prefix}5.5.5.5`)).toBeGreaterThan(0);
	});

	/**
	 * `DECR` on a key whose window already expired RECREATES it at -1 with no
	 * expiry. Split from the `DEL` that follows, a fault in between left that
	 * untimed key behind, and the listener swallows release failures, so nothing
	 * would have reported it.
	 */
	it('removes the counter rather than leaving an untimed one behind', async () => {
		const l = limiter(5);
		await l.release(peer('9.9.9.9'));
		expect(await redis.exists(`${prefix}9.9.9.9`)).toBe(0);

		// The same, for a slot released after its own window expired.
		await l.acquire(peer('7.7.7.7'));
		await redis.del(`${prefix}7.7.7.7`);
		await l.release(peer('7.7.7.7'));
		expect(await redis.exists(`${prefix}7.7.7.7`)).toBe(0);
	});
});

it('keeps the bounce and submission counters apart', async () => {
	await createConnectionLimiter(redis, 'mta:submission:conn:', 300, 1).acquire(peer('1.2.3.4'));
	expect(await redis.get('mta:submission:conn:1.2.3.4')).toBe('1');
	expect(await redis.get('mta:bounce:conn:1.2.3.4')).toBeNull();
	expect(
		await createConnectionLimiter(redis, 'mta:bounce:conn:', 300, 1).acquire(peer('1.2.3.4'))
	).toBe(true);
});
