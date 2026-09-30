import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auth-settled signal one-shot Convex calls wait on after a sign-in. The
 * module keeps state, so every case loads a fresh copy.
 */

async function load() {
	vi.resetModules();
	return import('../convexAuthReady');
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('convex auth readiness', () => {
	it('waits while the first auth config is pending, then reports the server answer', async () => {
		const auth = await load();
		const settled = vi.fn();
		void auth.whenConvexAuthSettled().then(settled);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(settled).not.toHaveBeenCalled();

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledWith(true);
	});

	it('answers at once when auth has already settled', async () => {
		const auth = await load();
		auth.reportConvexAuth(true);
		await expect(auth.whenConvexAuthSettled()).resolves.toBe(true);

		auth.reportConvexAuth(false);
		await expect(auth.whenConvexAuthSettled()).resolves.toBe(false);
	});

	it('resolves false when auth fails', async () => {
		const auth = await load();
		const answer = auth.whenConvexAuthSettled();

		auth.reportConvexAuth(false);
		await expect(answer).resolves.toBe(false);
	});

	it('waits again once a new config is installed (sign-in after a signed-out boot)', async () => {
		const auth = await load();
		auth.reportConvexAuth(false);

		auth.markConvexAuthPending();
		const settled = vi.fn();
		void auth.whenConvexAuthSettled().then(settled);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledWith(true);
	});

	it('gives up with false after the timeout and ignores a late answer', async () => {
		const auth = await load();
		const settled = vi.fn();
		void auth.whenConvexAuthSettled(5_000).then(settled);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(settled).toHaveBeenCalledWith(false);

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledOnce();
	});

	it('settles every waiter', async () => {
		const auth = await load();
		const answers = [auth.whenConvexAuthSettled(), auth.whenConvexAuthSettled()];

		auth.reportConvexAuth(true);
		await expect(Promise.all(answers)).resolves.toEqual([true, true]);
	});
});
