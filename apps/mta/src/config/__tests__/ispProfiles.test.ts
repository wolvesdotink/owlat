import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { DESTINATION_PROVIDER_PROFILES } from '../../config.js';
import { getProfile, listProfiles } from '../ispProfiles.js';
import { logger } from '../../monitoring/logger.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('destination-provider profile persistence', () => {
	let redis: RealRedis;

	beforeEach(() => {
		vi.clearAllMocks();
		redis = new Redis() as unknown as RealRedis;
	});

	it('fills fields missing from a legacy Redis profile with checked-in defaults', async () => {
		await redis.hset('mta:isp-profile:gmail', 'defaultRate', '150');

		expect(await getProfile(redis, 'gmail')).toEqual({
			...DESTINATION_PROVIDER_PROFILES['gmail'],
			defaultRate: 150,
		});
	});

	it.each([
		['defaultRate', 'Infinity'],
		['floor', '-1'],
		['maxConnections', '1.5'],
		['tlsMode', 'sometimes'],
	])('falls back safely when Redis field %s is corrupt', async (field, value) => {
		const expected = DESTINATION_PROVIDER_PROFILES['gmail']!;
		await redis.hset(
			'mta:isp-profile:gmail',
			'defaultRate',
			String(expected.defaultRate),
			field,
			value
		);

		expect(await getProfile(redis, 'gmail')).toEqual(expected);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(String) }),
			'Ignoring corrupt destination provider profile in Redis'
		);
	});

	it('does not expose arbitrary provider names from the Redis profile set', async () => {
		await redis.sadd('mta:isp-profiles', 'gmail', 'attacker.example');
		expect(Object.keys(await listProfiles(redis))).toEqual(['gmail']);
	});
});
