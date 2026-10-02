import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { releaseWebPushOnSignOut } from '../useWebPush';

/**
 * Sign-out releases this browser's push subscription first, and waits for it.
 * The whole release is bounded: a stalled registration lookup, server call or
 * browser unsubscribe never holds the sign-out for longer than 2.5 seconds.
 */

const ENDPOINT = 'https://push.example.com/device-1';
const never = <T>() => new Promise<T>(() => {});

function stubBrowser(options: {
	getRegistration?: () => Promise<unknown>;
	unsubscribe?: () => Promise<boolean>;
}) {
	const unsubscribe = vi.fn(options.unsubscribe ?? (async () => true));
	const subscription = { endpoint: ENDPOINT, unsubscribe };
	const getRegistration = vi.fn(
		options.getRegistration ??
			(async () => ({ pushManager: { getSubscription: async () => subscription } }))
	);
	vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
	return { unsubscribe };
}

function stubConvex(mutation: () => Promise<unknown>) {
	const fn = vi.fn(mutation);
	return { client: { mutation: fn } as unknown as ConvexClient, mutation: fn };
}

/** Start a release and report whether it has finished after `ms` of fake time. */
async function settledAfter(convex: ConvexClient | null, ms: number) {
	const done = vi.fn();
	void releaseWebPushOnSignOut(convex).then(done);
	await vi.advanceTimersByTimeAsync(ms);
	return done;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('releaseWebPushOnSignOut', () => {
	it('forgets the device on the server and in the browser', async () => {
		const { unsubscribe } = stubBrowser({});
		const { client, mutation } = stubConvex(async () => null);
		const done = await settledAfter(client, 0);
		expect(done).toHaveBeenCalled();
		expect(mutation).toHaveBeenCalledWith(expect.anything(), { endpoint: ENDPOINT });
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('gives up on a browser unsubscribe that never answers', async () => {
		stubBrowser({ unsubscribe: never });
		const { client } = stubConvex(async () => null);
		const done = await settledAfter(client, 2_499);
		expect(done).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toHaveBeenCalled();
	});

	it('gives up on a registration lookup that never answers', async () => {
		stubBrowser({ getRegistration: never });
		const { client, mutation } = stubConvex(async () => null);
		const done = await settledAfter(client, 2_500);
		expect(done).toHaveBeenCalled();
		expect(mutation).not.toHaveBeenCalled();
	});

	it('still unsubscribes the browser while the server call hangs', async () => {
		const { unsubscribe } = stubBrowser({});
		const { client } = stubConvex(never);
		const done = await settledAfter(client, 0);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(done).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(done).toHaveBeenCalled();
	});

	it('never rejects, whatever fails', async () => {
		stubBrowser({ unsubscribe: async () => Promise.reject(new Error('push service down')) });
		const { client } = stubConvex(async () => Promise.reject(new Error('offline')));
		await expect(releaseWebPushOnSignOut(client)).resolves.toBeUndefined();
	});
});
