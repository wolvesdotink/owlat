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

describe('waiting for an authenticated client', () => {
	it('answers at once when the client is already authenticated', async () => {
		const auth = await load();
		auth.reportConvexAuth(true);
		await expect(auth.whenConvexAuthenticated()).resolves.toBe(true);
	});

	it('keeps waiting through a failed report until a later token is accepted', async () => {
		const auth = await load();
		const settled = vi.fn();
		void auth.whenConvexAuthenticated().then(settled);

		// The token fetch failed during one re-auth; a session signal installs another.
		auth.reportConvexAuth(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();

		auth.markConvexAuthPending();
		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledWith(true);
	});

	it('does not treat a settled failure as authenticated', async () => {
		const auth = await load();
		auth.reportConvexAuth(false);
		const settled = vi.fn();
		void auth.whenConvexAuthenticated(5_000).then(settled);

		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalledWith(false);
	});

	it('gives up with false after the timeout and ignores a late answer', async () => {
		const auth = await load();
		const settled = vi.fn();
		void auth.whenConvexAuthenticated(5_000).then(settled);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(settled).toHaveBeenCalledWith(false);

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledOnce();
	});

	it('leaves a settled-wait unaffected: a failed report still ends that wait', async () => {
		const auth = await load();
		const settled = auth.whenConvexAuthSettled();
		const authenticated = vi.fn();
		void auth.whenConvexAuthenticated().then(authenticated);

		auth.reportConvexAuth(false);
		await expect(settled).resolves.toBe(false);
		expect(authenticated).not.toHaveBeenCalled();

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(authenticated).toHaveBeenCalledWith(true);
	});
});
