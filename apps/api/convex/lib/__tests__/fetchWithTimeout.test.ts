import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FETCH_TIMEOUTS,
	FetchTimeoutError,
	fetchWithTimeout,
	isFetchTimeout,
} from '../fetchWithTimeout';

/**
 * `fetchWithTimeout` is the one deadline every outbound request in the backend
 * goes through. These pin the contract the call sites rely on: the caller's
 * init reaches `fetch` untouched, a hung peer rejects with a `TimeoutError`
 * that names the budget, and every other failure is passed through as it was.
 */

/** A `fetch` that never answers on its own and rejects the way undici does when its signal fires. */
function hangingFetch() {
	return vi.fn(
		(_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
			})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
	it('passes the caller init through and adds an abort signal', async () => {
		const fetchMock = vi.fn(async () => new Response('ok'));
		vi.stubGlobal('fetch', fetchMock);

		const res = await fetchWithTimeout(
			'https://mta.test/suppression',
			{ method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' },
			1_000
		);

		expect(await res.text()).toBe('ok');
		const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
		expect(url).toBe('https://mta.test/suppression');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ Authorization: 'Bearer k' });
		expect(init.body).toBe('{}');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.signal!.aborted).toBe(false);
	});

	it('rejects a request that has not answered within the budget with a TimeoutError naming it', async () => {
		vi.stubGlobal('fetch', hangingFetch());

		const error = await fetchWithTimeout('https://mta.test/hang', {}, 20).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FetchTimeoutError);
		expect(isFetchTimeout(error)).toBe(true);
		expect((error as FetchTimeoutError).timeoutMs).toBe(20);
		expect((error as Error).message).toBe('Request timed out after 20 ms');
	});

	it('passes every other failure through unchanged', async () => {
		const boom = new TypeError('fetch failed');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw boom;
			})
		);

		await expect(fetchWithTimeout('https://mta.test/down', {}, 1_000)).rejects.toBe(boom);
		expect(isFetchTimeout(boom)).toBe(false);
	});

	it('keeps each budget above the slowest honest answer its peer can give', () => {
		// The MTA gives clamd 5 s to connect and 30 s to scan; a shorter budget
		// here would turn a slow real scan into a fail-open skip.
		expect(FETCH_TIMEOUTS.attachmentScan).toBeGreaterThanOrEqual(35_000);
		// A hung external relay must still end inside Convex's 10-minute action limit.
		expect(FETCH_TIMEOUTS.externalSend).toBeLessThan(600_000);
	});
});
