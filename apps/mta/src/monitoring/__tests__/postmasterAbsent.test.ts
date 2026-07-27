/**
 * The additive-only proof for Google Postmaster Tools.
 *
 * Postmaster needs a free Google account and DNS verification. A deployment
 * that has neither is a SUPPORTED configuration: the collector returns early,
 * touches no Redis state, delivers no webhook, logs no error and throws
 * nothing. Absence lowers measurement confidence and does nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { MtaConfig } from '../../config.js';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyPostmasterConvex: vi.fn().mockResolvedValue({
		disposition: 'accepted_authorized',
		retained: true,
	}),
}));
vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyPostmasterConvex } from '../../webhooks/convexNotifier.js';
import { logger } from '../logger.js';
import { fetchPostmasterData } from '../postmaster.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Google Postmaster without credentials', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		await new Redis().flushall();
	});

	it('returns early without a network call, a webhook, a lock or a log line', async () => {
		const redis = new Redis();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(fetchPostmasterData(redis, {} as MtaConfig)).resolves.toBeUndefined();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(notifyPostmasterConvex).not.toHaveBeenCalled();
		expect(await redis.keys('*')).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('stays inert across repeated sweeps rather than degrading over time', async () => {
		const redis = new Redis();
		vi.stubGlobal('fetch', vi.fn());

		for (let sweep = 0; sweep < 3; sweep++) {
			await expect(
				fetchPostmasterData(redis, { googlePostmaster: undefined } as MtaConfig)
			).resolves.toBeUndefined();
		}

		expect(await redis.keys('*')).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
	});
});
