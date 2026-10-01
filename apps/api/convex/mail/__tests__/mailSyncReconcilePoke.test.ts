import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `pokeMailSyncReconcile` wakes the mail-sync worker after a connect (plan 3.6),
 * so a new mailbox starts syncing now rather than on the worker's next 30 s
 * reconcile tick. It is best effort: the tick still covers every failure, so
 * nothing here may throw.
 */

const env = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('../../lib/env', () => ({
	getOptional: (name: string) => env.values[name],
}));
vi.mock('../../lib/runtimeLog', () => ({
	logError: vi.fn(),
	logWarn: vi.fn(),
	logInfo: vi.fn(),
}));

import { pokeMailSyncReconcile } from '../mtaClient';

const fetchMock = vi.fn();

beforeEach(() => {
	env.values = { MAIL_SYNC_API_URL: 'http://mail-sync.test/', MAIL_SYNC_API_KEY: 'sync-key' };
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('pokeMailSyncReconcile', () => {
	it('POSTs /reconcile with the worker key', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

		await expect(pokeMailSyncReconcile()).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
		expect(url).toBe('http://mail-sync.test/reconcile');
		expect(init.method).toBe('POST');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sync-key');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('does nothing when the worker is not configured', async () => {
		env.values = {};
		await expect(pokeMailSyncReconcile()).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('swallows an unreachable worker and a worker without the route', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
		await expect(pokeMailSyncReconcile()).resolves.toBe(false);

		fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
		await expect(pokeMailSyncReconcile()).resolves.toBe(false);
	});
});
