// @vitest-environment happy-dom
/**
 * The welcome stamp (#1203): a failed `markWelcomed` is retried with the
 * first-login middleware's bounded backoff, never sent while the Convex client
 * is anonymous, logged with its cause, and cached only after a commit. The
 * caller's AbortSignal ends the run: nothing is sent after it fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSIENT_RETRY_LIMIT } from '~/lib/queryRetry';

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('~/lib/runtimeLog', () => ({ logWarn, logError }));

const USER_ID = 'user-1';
const CACHE_KEY = `owlat:welcomed:${USER_ID}`;
/** Longer than any backoff step (8 s cap plus 20% spread) and the auth wait. */
const PAST_ANY_WAIT = 20_000;

/** Fresh copies: the auth-readiness module keeps state between calls. */
async function load() {
	vi.resetModules();
	const auth = await import('../convexAuthReady');
	const stamp = await import('../welcomeStamp');
	return { auth, ...stamp };
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	logWarn.mockReset();
	logError.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('stampWelcomed', () => {
	it('stamps once and caches when the first attempt commits', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		const send = vi.fn().mockResolvedValue(null);

		await expect(stampWelcomed({ userId: USER_ID, send })).resolves.toBe('saved');
		expect(send).toHaveBeenCalledOnce();
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
		expect(logWarn).not.toHaveBeenCalled();
	});

	it('retries after a failure with backoff and caches once a retry commits', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		const timeout = new Error('Function execution timed out');
		const send = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce(null);

		const result = stampWelcomed({ userId: USER_ID, send });
		await vi.advanceTimersByTimeAsync(0);
		expect(send).toHaveBeenCalledOnce();
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/'), timeout);

		// Backoff: not straight away (first step is 1 s, spread to at least 0.8 s).
		await vi.advanceTimersByTimeAsync(799);
		expect(send).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(PAST_ANY_WAIT);
		await expect(result).resolves.toBe('saved');
		expect(send).toHaveBeenCalledTimes(2);
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
	});

	it('gives up after the bounded retries without caching, and logs why', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		const failure = new Error('Server Error');
		const send = vi.fn().mockRejectedValue(failure);

		const result = stampWelcomed({ userId: USER_ID, send });
		await vi.advanceTimersByTimeAsync(PAST_ANY_WAIT * (TRANSIENT_RETRY_LIMIT + 1));

		await expect(result).resolves.toBe('failed');
		expect(send).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 1);
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 1);
		expect(logError).toHaveBeenCalledOnce();
		expect(logError).toHaveBeenCalledWith(expect.stringContaining('Giving up'), failure);
	});

	it('never sends as an anonymous caller: it waits for the next authenticated report', async () => {
		const { auth, stampWelcomed } = await load();
		// A token fetch failed during a re-auth after sign-in.
		auth.reportConvexAuth(false);
		const send = vi.fn().mockResolvedValue(null);

		const result = stampWelcomed({ userId: USER_ID, send });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).not.toHaveBeenCalled();

		// A session signal installs a new token, and the server accepts it.
		auth.markConvexAuthPending();
		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);

		await expect(result).resolves.toBe('saved');
		expect(send).toHaveBeenCalledOnce();
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
	});

	it('counts an attempt the client never authenticated for, and gives up unsent', async () => {
		const { auth, stampWelcomed, WELCOME_STAMP_AUTH_WAIT_MS } = await load();
		auth.reportConvexAuth(false);
		const send = vi.fn().mockResolvedValue(null);

		const result = stampWelcomed({ userId: USER_ID, send });
		await vi.advanceTimersByTimeAsync(
			(WELCOME_STAMP_AUTH_WAIT_MS + PAST_ANY_WAIT) * (TRANSIENT_RETRY_LIMIT + 1)
		);

		await expect(result).resolves.toBe('failed');
		expect(send).not.toHaveBeenCalled();
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('not sent'));
		expect(logError).toHaveBeenCalledOnce();
	});

	it('counts a send that never answers as a failed attempt and retries', async () => {
		const { auth, stampWelcomed, WELCOME_STAMP_SEND_DEADLINE_MS } = await load();
		auth.reportConvexAuth(true);
		const send = vi
			.fn()
			.mockReturnValueOnce(new Promise(() => {}))
			.mockResolvedValueOnce(null);

		const result = stampWelcomed({ userId: USER_ID, send });
		await vi.advanceTimersByTimeAsync(WELCOME_STAMP_SEND_DEADLINE_MS - 1);
		expect(send).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1 + PAST_ANY_WAIT);
		await expect(result).resolves.toBe('saved');
		expect(send).toHaveBeenCalledTimes(2);
		expect(logWarn).toHaveBeenCalledWith(
			expect.stringContaining('attempt 1/'),
			expect.objectContaining({ message: expect.stringContaining('did not answer') })
		);
	});
});

describe('stampWelcomed, aborted by its caller', () => {
	it('sends nothing when aborted during the auth wait, even if auth lands later', async () => {
		const { auth, stampWelcomed } = await load();
		auth.markConvexAuthPending();
		const send = vi.fn().mockResolvedValue(null);
		const run = new AbortController();

		const result = stampWelcomed({ userId: USER_ID, send, signal: run.signal });
		await vi.advanceTimersByTimeAsync(1_000);
		run.abort();
		await expect(result).resolves.toBe('aborted');

		auth.reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(PAST_ANY_WAIT);
		expect(send).not.toHaveBeenCalled();
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		expect(logError).not.toHaveBeenCalled();
		// The wait's timer went with it: nothing is left to fire.
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops after the current attempt when aborted during the backoff', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		const send = vi.fn().mockRejectedValue(new Error('Server Error'));
		const run = new AbortController();

		const result = stampWelcomed({ userId: USER_ID, send, signal: run.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(send).toHaveBeenCalledOnce();

		run.abort();
		await expect(result).resolves.toBe('aborted');
		await vi.advanceTimersByTimeAsync(PAST_ANY_WAIT * (TRANSIENT_RETRY_LIMIT + 1));
		expect(send).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(logError).not.toHaveBeenCalled();
	});

	it('does not retry a send that fails after the abort', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		let fail!: (error: Error) => void;
		const send = vi.fn().mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
		const run = new AbortController();

		const result = stampWelcomed({ userId: USER_ID, send, signal: run.signal });
		await vi.advanceTimersByTimeAsync(0);
		run.abort();
		fail(new Error('Forbidden'));

		await expect(result).resolves.toBe('aborted');
		await vi.advanceTimersByTimeAsync(PAST_ANY_WAIT);
		expect(send).toHaveBeenCalledOnce();
	});

	it('sends nothing when the signal is already aborted', async () => {
		const { auth, stampWelcomed } = await load();
		auth.reportConvexAuth(true);
		const send = vi.fn().mockResolvedValue(null);

		await expect(
			stampWelcomed({ userId: USER_ID, send, signal: AbortSignal.abort() })
		).resolves.toBe('aborted');
		expect(send).not.toHaveBeenCalled();
	});
});
