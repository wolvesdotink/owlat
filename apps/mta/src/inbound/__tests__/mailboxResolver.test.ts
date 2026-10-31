import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { bumpUsedBytes, findMailboxRoute, setMailboxCache } from '../mailboxResolver.js';

const KEY = 'mta:mailbox:alice@example.com';
const valid = {
	mailboxId: 'mailbox-1',
	organizationId: 'organization-1',
	usedBytes: 100,
	cachedAt: 1_700_000_000_000,
};

describe('mailbox cache entries', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	it('round-trips an entry and bumps usedBytes, keeping the quota and unknown fields', async () => {
		await setMailboxCache(redis, 'Alice@example.com', {
			mailboxId: 'mailbox-1',
			organizationId: 'organization-1',
			quotaBytes: 1_000,
			usedBytes: 100,
		});
		const raw = JSON.parse((await redis.get(KEY))!) as Record<string, unknown>;
		await redis.set(KEY, JSON.stringify({ ...raw, addedLater: true }));

		await bumpUsedBytes(redis, 'alice@example.com', 50);
		expect(await findMailboxRoute(redis, 'alice@example.com')).toMatchObject({
			mailboxId: 'mailbox-1',
			organizationId: 'organization-1',
			quotaBytes: 1_000,
			usedBytes: 150,
			addedLater: true,
		});
	});

	it('keeps a legacy entry without a quota', async () => {
		await redis.set(KEY, JSON.stringify(valid));
		const entry = await findMailboxRoute(redis, 'alice@example.com');
		expect(entry).toEqual(valid);
	});

	it.each<[string, unknown]>([
		['null', null],
		['a number', 42],
		['an array', [valid]],
		['an empty object', {}],
		['a missing mailboxId', { ...valid, mailboxId: undefined }],
		['an empty organizationId', { ...valid, organizationId: '' }],
		['a non-numeric usedBytes', { ...valid, usedBytes: '100' }],
		['a non-numeric cachedAt', { ...valid, cachedAt: null }],
		['a non-numeric quotaBytes', { ...valid, quotaBytes: 'unlimited' }],
	])('neither routes to nor rewrites an entry with %s', async (_label, blob) => {
		const raw = JSON.stringify(blob);
		await redis.set(KEY, raw);

		expect(await findMailboxRoute(redis, 'alice@example.com')).toBeNull();
		await bumpUsedBytes(redis, 'alice@example.com', 50);
		expect(await redis.get(KEY)).toBe(raw);
	});
});
