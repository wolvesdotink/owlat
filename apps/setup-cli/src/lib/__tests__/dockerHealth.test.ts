import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForUrl } from '../dockerHealth';

/** A fetch mock that returns a Response-like object with the given status. */
function resp(status: number): { status: number } {
	return { status };
}

describe('waitForUrl', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('resolves on the first probe when fetch returns a status in [200,500)', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(resp(200) as unknown as Response);

		await expect(
			waitForUrl({ url: 'http://host:3210/version', timeoutMs: 1000, intervalMs: 5 }),
		).resolves.toBeUndefined();

		// A single successful probe — no retries needed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://host:3210/version',
			expect.objectContaining({ signal: expect.any(Object) }),
		);
	});

	it('treats a 404 (unrouted path) as reachable and resolves', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(resp(404) as unknown as Response);

		await expect(
			waitForUrl({ url: 'http://host:3210/', timeoutMs: 1000, intervalMs: 5 }),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries (firing onTick) on a 5xx and resolves once the backend is up', async () => {
		const fetchMock = vi.mocked(fetch);
		// Two not-ready 5xx responses, then a healthy 200.
		fetchMock
			.mockResolvedValueOnce(resp(503) as unknown as Response)
			.mockResolvedValueOnce(resp(500) as unknown as Response)
			.mockResolvedValue(resp(200) as unknown as Response);

		const ticks: number[] = [];
		await waitForUrl({
			url: 'http://host:3210/version',
			timeoutMs: 2000,
			intervalMs: 5,
			onTick: (elapsed) => ticks.push(elapsed),
		});

		expect(fetchMock).toHaveBeenCalledTimes(3);
		// onTick fires once per non-resolving poll (the two 5xx probes), not on success.
		expect(ticks).toHaveLength(2);
		expect(ticks[0]).toBeGreaterThanOrEqual(0);
	});

	it('swallows network errors (connection refused) and keeps polling until success', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockResolvedValue(resp(200) as unknown as Response);

		const ticks: number[] = [];
		await waitForUrl({
			url: 'http://host:3210/version',
			timeoutMs: 2000,
			intervalMs: 5,
			onTick: (elapsed) => ticks.push(elapsed),
		});

		// The two rejections did not bubble up; polling continued to the 200.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(ticks).toHaveLength(2);
	});

	it('rejects with a timeout error when fetch never succeeds before timeoutMs', async () => {
		const fetchMock = vi.mocked(fetch);
		// Always unreachable — the loop must give up at the deadline.
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

		await expect(
			waitForUrl({ url: 'http://host:3210/version', timeoutMs: 30, intervalMs: 5 }),
		).rejects.toThrow(/Timed out after .*waiting for http:\/\/host:3210\/version/);

		// It polled at least once before timing out.
		expect(fetchMock).toHaveBeenCalled();
	});

	it('does not leave the per-request abort timer pending after a rejected fetch', async () => {
		// The module sets a setTimeout for the AbortController and must clear it
		// in `finally`. A single failing probe followed by a timeout means every
		// scheduled abort timer should have been cleared — verify clearTimeout is
		// invoked at least as many times as fetch was called.
		const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

		await expect(
			waitForUrl({ url: 'http://host:3210/version', timeoutMs: 30, intervalMs: 5 }),
		).rejects.toThrow(/Timed out/);

		const calls = fetchMock.mock.calls.length;
		expect(calls).toBeGreaterThan(0);
		expect(clearSpy).toHaveBeenCalledTimes(calls);
	});
});
