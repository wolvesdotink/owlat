import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePostboxPrefetch, type PrefetchClient } from '../usePostboxPrefetch';

type BodyResult = {
	htmlInline: string | null;
	textInline: string | null;
	htmlUrl: string | null;
	textUrl: string | null;
} | null;

function makeFakeClient() {
	const subscriptions: Array<{
		messageId: string;
		onData: (data: BodyResult) => void;
		onError: (e: Error) => void;
		unsubscribe: ReturnType<typeof vi.fn>;
	}> = [];
	const client: PrefetchClient = {
		onUpdate: vi.fn((_query: unknown, args: { messageId: string }, onData, onError) => {
			const unsubscribe = vi.fn();
			subscriptions.push({
				messageId: args.messageId,
				onData: onData as (data: BodyResult) => void,
				onError: (onError ?? (() => {})) as (e: Error) => void,
				unsubscribe,
			});
			return unsubscribe;
		}) as unknown as PrefetchClient['onUpdate'],
	};
	return { client, subscriptions };
}

describe('usePostboxPrefetch', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('warms the requested targets only after the debounce window', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['next-id', 'prev-id']);
		expect(subscriptions).toHaveLength(0);

		vi.advanceTimersByTime(149);
		expect(subscriptions).toHaveLength(0);

		vi.advanceTimersByTime(1);
		expect(subscriptions.map((s) => s.messageId)).toEqual(['next-id', 'prev-id']);
	});

	it('coalesces rapid focus changes — only the last targets are warmed', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		// Holding j: each keypress reschedules; intermediate rows never fetch.
		prefetch(['b', 'a']);
		vi.advanceTimersByTime(100);
		prefetch(['c', 'b']);
		vi.advanceTimersByTime(100);
		prefetch(['d', 'c']);
		expect(subscriptions).toHaveLength(0);

		vi.advanceTimersByTime(150);
		expect(subscriptions.map((s) => s.messageId)).toEqual(['d', 'c']);
	});

	it('skips ids that are already warm instead of re-subscribing', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch, isWarm } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['a', 'b']);
		vi.advanceTimersByTime(150);
		expect(subscriptions).toHaveLength(2);

		prefetch(['a', 'b']);
		vi.advanceTimersByTime(150);
		expect(subscriptions).toHaveLength(2);
		expect(isWarm('a')).toBe(true);
		expect(isWarm('b')).toBe(true);
	});

	it('ignores null/undefined targets (list edges)', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch([undefined, null]); // focused row 0 of a 1-row list
		vi.advanceTimersByTime(150);
		expect(subscriptions).toHaveLength(0);

		prefetch(['a', undefined]);
		vi.advanceTimersByTime(150);
		expect(subscriptions.map((s) => s.messageId)).toEqual(['a']);
	});

	it('caps the cache at maxEntries, unsubscribing the least recently used', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch, isWarm, size } = usePostboxPrefetch({
			client,
			debounceMs: 0,
			maxEntries: 3,
		});

		for (const id of ['a', 'b', 'c']) {
			prefetch([id]);
			vi.advanceTimersByTime(1);
		}
		expect(size()).toBe(3);

		// Re-warm 'a' so it becomes most recent, then overflow with 'd' and 'e'.
		prefetch(['a']);
		vi.advanceTimersByTime(1);
		prefetch(['d']);
		vi.advanceTimersByTime(1);
		prefetch(['e']);
		vi.advanceTimersByTime(1);

		expect(size()).toBe(3);
		expect(isWarm('a')).toBe(true);
		expect(isWarm('d')).toBe(true);
		expect(isWarm('e')).toBe(true);
		expect(isWarm('b')).toBe(false);
		expect(isWarm('c')).toBe(false);

		const bySubId = (id: string) => subscriptions.find((s) => s.messageId === id && s.unsubscribe.mock.calls.length > 0);
		expect(bySubId('b')).toBeDefined();
		expect(bySubId('c')).toBeDefined();
		// Survivors keep their subscription open.
		expect(subscriptions.filter((s) => s.messageId === 'e')[0]?.unsubscribe).not.toHaveBeenCalled();
	});

	it('primes the blob URL for storage-backed bodies, once per message', async () => {
		const { client, subscriptions } = makeFakeClient();
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('body') }));
		const { prefetch } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['blob-msg']);
		vi.advanceTimersByTime(1);

		const result: BodyResult = {
			htmlInline: null,
			textInline: null,
			htmlUrl: 'https://storage.example/signed-html',
			textUrl: null,
		};
		subscriptions[0]!.onData(result);
		subscriptions[0]!.onData(result); // live re-emit — must not double-fetch
		await vi.runAllTimersAsync();

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith('https://storage.example/signed-html');
	});

	it('does not fetch anything for inline bodies', async () => {
		const { client, subscriptions } = makeFakeClient();
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('') }));
		const { prefetch } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['inline-msg']);
		vi.advanceTimersByTime(1);
		subscriptions[0]!.onData({
			htmlInline: '<p>hi</p>',
			textInline: null,
			htmlUrl: 'https://storage.example/should-not-fetch',
			textUrl: null,
		});
		await vi.runAllTimersAsync();

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('swallows subscription and blob-fetch errors (fail-soft)', async () => {
		const { client, subscriptions } = makeFakeClient();
		const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));
		const { prefetch, isWarm } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['err-msg']);
		vi.advanceTimersByTime(1);

		// Subscription error callback must not throw.
		expect(() => subscriptions[0]!.onError(new Error('query failed'))).not.toThrow();

		// Blob fetch rejection is swallowed (no unhandled rejection).
		subscriptions[0]!.onData({
			htmlInline: null,
			textInline: null,
			htmlUrl: null,
			textUrl: 'https://storage.example/signed-text',
		});
		await vi.runAllTimersAsync();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(isWarm('err-msg')).toBe(true);
	});

	it('swallows a throwing onUpdate (client hiccup) without warming', () => {
		const client: PrefetchClient = {
			onUpdate: vi.fn(() => {
				throw new Error('client not ready');
			}) as unknown as PrefetchClient['onUpdate'],
		};
		const { prefetch, size } = usePostboxPrefetch({ client, debounceMs: 0 });

		prefetch(['a']);
		expect(() => vi.advanceTimersByTime(1)).not.toThrow();
		expect(size()).toBe(0);
	});

	it('is a no-op without a Convex client', () => {
		const { prefetch, size } = usePostboxPrefetch({ client: null, debounceMs: 0 });
		prefetch(['a']);
		expect(() => vi.advanceTimersByTime(1)).not.toThrow();
		expect(size()).toBe(0);
	});

	it('clear() cancels a pending warm-up and unsubscribes everything', () => {
		const { client, subscriptions } = makeFakeClient();
		const { prefetch, clear, size } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['a']);
		vi.advanceTimersByTime(150);
		prefetch(['b']); // still pending
		clear();
		vi.advanceTimersByTime(150);

		expect(size()).toBe(0);
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
	});
});
