import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `recheckIdentity` asks the MTA to re-observe its outbound identity from live
 * DNS BEFORE the warming payload is read, so a checklist "Verify now" judges a
 * PTR the operator just fixed instead of the verdict the hourly sweep stored.
 */

const env = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('../../lib/env', () => ({
	getOptional: (name: string) => env.values[name],
}));
vi.mock('../../lib/runtimeLog', () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { syncWarmingState } from '../warmingSync';
import { MTA_FETCH_TIMEOUT_MS } from '../../mail/mtaClient';

const handler = (
	syncWarmingState as unknown as {
		_handler: (ctx: unknown, args: { recheckIdentity?: boolean }) => Promise<void>;
	}
)._handler;

// The MTA's `/ip-reputation` wire shape, not the normalized row Convex stores.
const payload = {
	date: '2026-09-28',
	ips: [
		{
			ip: '203.0.113.10',
			sent: 0,
			bounced: 0,
			deferred: 0,
			warmingPhase: 'graduated',
			warmingDay: 30,
			pool: 'campaign',
			active: true,
		},
	],
};

function makeCtx() {
	return {
		runQuery: vi.fn(async () => null),
		runMutation: vi.fn(async () => undefined),
	};
}

const fetchMock = vi.fn();

beforeEach(() => {
	env.values = { MTA_INTERNAL_URL: 'http://mta.test', MTA_API_KEY: 'mta-key' };
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function requestedUrls(): string[] {
	return fetchMock.mock.calls.map(([url]) => String(url));
}

describe('syncWarmingState', () => {
	it('re-checks the outbound identity before reading the warming payload', async () => {
		fetchMock.mockImplementation(async () => Response.json(payload));
		const ctx = makeCtx();

		await handler(ctx, { recheckIdentity: true });

		expect(requestedUrls()).toEqual([
			'http://mta.test/identity/recheck',
			'http://mta.test/ip-reputation',
		]);
		const recheckInit = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(recheckInit.method).toBe('POST');
		expect(new Headers(recheckInit.headers).get('Authorization')).toBe('Bearer mta-key');
		expect(ctx.runMutation).toHaveBeenCalledTimes(1);
	});

	it('leaves the scheduled sync to the stored verdicts', async () => {
		fetchMock.mockImplementation(async () => Response.json(payload));

		await handler(makeCtx(), {});

		expect(requestedUrls()).toEqual(['http://mta.test/ip-reputation']);
	});

	it('still syncs the stored verdicts when the re-check fails', async () => {
		fetchMock.mockImplementation(async (url: string | URL) => {
			if (String(url).endsWith('/identity/recheck')) throw new Error('connection refused');
			return Response.json(payload);
		});
		const ctx = makeCtx();

		await handler(ctx, { recheckIdentity: true });

		expect(requestedUrls()).toContain('http://mta.test/ip-reputation');
		expect(ctx.runMutation).toHaveBeenCalledTimes(1);
	});

	it('syncs through MTA_API_URL when MTA_INTERNAL_URL is unset', async () => {
		env.values = { MTA_API_URL: 'https://mta.public.test', MTA_API_KEY: 'mta-key' };
		fetchMock.mockImplementation(async () => Response.json(payload));
		const ctx = makeCtx();

		await handler(ctx, {});

		expect(requestedUrls()).toEqual(['https://mta.public.test/ip-reputation']);
		expect(ctx.runMutation).toHaveBeenCalledTimes(1);
	});

	it('joins a base URL with a trailing slash with a single slash', async () => {
		env.values = { MTA_INTERNAL_URL: 'http://mta.test//', MTA_API_KEY: 'mta-key' };
		fetchMock.mockImplementation(async () => Response.json(payload));
		const ctx = makeCtx();
		ctx.runQuery.mockResolvedValue('org_1' as never);

		await handler(ctx, { recheckIdentity: true });

		expect(requestedUrls()).toEqual([
			'http://mta.test/identity/recheck',
			'http://mta.test/ip-reputation?organizationId=org_1',
		]);
	});

	it('skips silently without an API key', async () => {
		env.values = { MTA_INTERNAL_URL: 'http://mta.test' };

		await handler(makeCtx(), {});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('aborts a hung IP reputation request at the timeout and keeps the stored state', async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const ctx = makeCtx();

		const run = handler(ctx, {});
		await vi.advanceTimersByTimeAsync(MTA_FETCH_TIMEOUT_MS - 1);
		expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await run;

		expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
		expect(ctx.runMutation).not.toHaveBeenCalled();
	});
});
