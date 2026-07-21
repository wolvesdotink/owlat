import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { DESTINATION_PROVIDER_PROFILES } from '../../config.js';
import { deleteProfile, getProfile, listProfiles, setProfile } from '../ispProfiles.js';
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

	it('uses all checked-in Gmail defaults when its Redis profile is absent', async () => {
		const fallback = DESTINATION_PROVIDER_PROFILES['__default__']!;
		await redis.hset(
			'mta:isp-profile:__default__',
			...Object.entries(fallback).flatMap(([field, value]) => [field, String(value)])
		);
		expect(await getProfile(redis, 'gmail')).toEqual(DESTINATION_PROVIDER_PROFILES['gmail']);
	});

	it('reserves the Redis default profile for the other provider bucket', async () => {
		const fallback = { ...DESTINATION_PROVIDER_PROFILES['__default__']!, defaultRate: 45 };
		await redis.hset(
			'mta:isp-profile:__default__',
			...Object.entries(fallback).flatMap(([field, value]) => [field, String(value)])
		);
		expect(await getProfile(redis, 'other')).toEqual(fallback);
	});

	it('keeps a deleted Gmail override listed with every checked-in default', async () => {
		await setProfile(redis, 'gmail', { defaultRate: 120, maxConnections: 8 });
		expect(await deleteProfile(redis, 'gmail')).toBe(true);

		expect(await listProfiles(redis)).toEqual({
			gmail: DESTINATION_PROVIDER_PROFILES['gmail'],
		});
	});
});
