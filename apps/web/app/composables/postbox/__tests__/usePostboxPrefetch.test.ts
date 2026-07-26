import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	consumeResolvedPostboxMessageBody,
	resolvePostboxMessageBody,
} from '../postboxBodyResolver';
import { usePostboxPrefetch, type PrefetchClient } from '../usePostboxPrefetch';

type BodyResult = {
	htmlInline: string | null;
	textInline: string | null;
	htmlUrl: string | null;
	textUrl: string | null;
} | null;

function makeFakeClient(result: BodyResult = null) {
	const action = vi.fn((_action: unknown, _args: { messageId: string }) => Promise.resolve(result));
	return {
		client: { action } as unknown as PrefetchClient,
		action,
	};
}

describe('usePostboxPrefetch', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('warms the requested targets only after the debounce window', async () => {
		const { client, action } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['next-id', 'prev-id']);
		expect(action).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(149);
		expect(action).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(action.mock.calls.map((call) => call[1].messageId)).toEqual(['next-id', 'prev-id']);
	});

	it('coalesces rapid focus changes so only the last targets are warmed', async () => {
		const { client, action } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['b', 'a']);
		await vi.advanceTimersByTimeAsync(100);
		prefetch(['c', 'b']);
		await vi.advanceTimersByTimeAsync(100);
		prefetch(['d', 'c']);
		expect(action).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(150);
		expect(action.mock.calls.map((call) => call[1].messageId)).toEqual(['d', 'c']);
	});

	it('skips ids that are already warm', async () => {
		const { client, action } = makeFakeClient();
		const { prefetch, isWarm } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['a', 'b']);
		await vi.advanceTimersByTimeAsync(150);
		expect(action).toHaveBeenCalledTimes(2);

		prefetch(['a', 'b']);
		await vi.advanceTimersByTimeAsync(150);
		expect(action).toHaveBeenCalledTimes(2);
		expect(isWarm('a')).toBe(true);
		expect(isWarm('b')).toBe(true);
	});

	it('ignores null and undefined targets at list edges', async () => {
		const { client, action } = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch([undefined, null]);
		await vi.advanceTimersByTimeAsync(150);
		expect(action).not.toHaveBeenCalled();

		prefetch(['a', undefined]);
		await vi.advanceTimersByTimeAsync(150);
		expect(action.mock.calls.map((call) => call[1].messageId)).toEqual(['a']);
	});

	it('caps the warm set with least-recently-used eviction', async () => {
		const { client } = makeFakeClient();
		const { prefetch, isWarm, size } = usePostboxPrefetch({
			client,
			debounceMs: 0,
			maxEntries: 3,
		});

		for (const id of ['a', 'b', 'c']) {
			prefetch([id]);
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(size()).toBe(3);

		// Re-warm 'a' so it becomes most recent, then overflow with 'd' and 'e'.
		for (const id of ['a', 'd', 'e']) {
			prefetch([id]);
			await vi.advanceTimersByTimeAsync(1);
		}

		expect(size()).toBe(3);
		expect(isWarm('a')).toBe(true);
		expect(isWarm('d')).toBe(true);
		expect(isWarm('e')).toBe(true);
		expect(isWarm('b')).toBe(false);
		expect(isWarm('c')).toBe(false);
	});

	it('shares a fully resolved storage-backed body with the reader', async () => {
		const { client, action } = makeFakeClient({
			htmlInline: null,
			textInline: null,
			htmlUrl: 'https://storage.example/signed-html',
			textUrl: null,
		});
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('body') }));
		const { prefetch } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['blob-msg', 'blob-msg']);
		await vi.advanceTimersByTimeAsync(1);
		const resolved = await consumeResolvedPostboxMessageBody(client, 'blob-msg', fetchImpl);

		expect(resolved).toEqual({ html: 'body', text: null });
		expect(action).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith('https://storage.example/signed-html');

		await resolvePostboxMessageBody(client, 'blob-msg', fetchImpl);
		expect(action).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not retain an oversized decrypted body', async () => {
		const oversizedBody = 'x'.repeat(512 * 1024 + 1);
		const { client, action } = makeFakeClient({
			htmlInline: oversizedBody,
			textInline: null,
			htmlUrl: null,
			textUrl: null,
		});
		const { prefetch } = usePostboxPrefetch({ client, debounceMs: 0 });

		prefetch(['oversized']);
		await vi.advanceTimersByTimeAsync(1);
		await resolvePostboxMessageBody(client, 'oversized');

		expect(action).toHaveBeenCalledTimes(2);
	});

	it('evicts the least-recently-used bodies when the aggregate cache budget is exceeded', async () => {
		const action = vi.fn(async () => ({
			htmlInline: 'x'.repeat(400 * 1024),
			textInline: null,
			htmlUrl: null,
			textUrl: null,
		}));
		const client = { action } as unknown as PrefetchClient;

		for (const messageId of ['a', 'b', 'c', 'd', 'e', 'f']) {
			await resolvePostboxMessageBody(client, messageId);
		}
		await resolvePostboxMessageBody(client, 'a');

		expect(action).toHaveBeenCalledTimes(7);
	});

	it('does not perform a browser fetch for an inline body', async () => {
		const { client } = makeFakeClient({
			htmlInline: '<p>hi</p>',
			textInline: null,
			htmlUrl: 'https://storage.example/should-not-fetch',
			textUrl: null,
		});
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('') }));
		const { prefetch } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['inline-msg']);
		await vi.advanceTimersByTimeAsync(1);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('swallows action and blob-fetch errors and allows a later retry', async () => {
		const action = vi
			.fn()
			.mockRejectedValueOnce(new Error('action unavailable'))
			.mockResolvedValueOnce({
				htmlInline: null,
				textInline: null,
				htmlUrl: 'https://storage.example/signed-html',
				textUrl: null,
			});
		const client = { action } as unknown as PrefetchClient;
		const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));
		const { prefetch, isWarm } = usePostboxPrefetch({ client, fetchImpl, debounceMs: 0 });

		prefetch(['err-msg']);
		await vi.advanceTimersByTimeAsync(1);
		expect(isWarm('err-msg')).toBe(false);

		prefetch(['err-msg']);
		await vi.advanceTimersByTimeAsync(1);
		expect(action).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(isWarm('err-msg')).toBe(false);
	});

	it('never exceeds the configured action concurrency', async () => {
		const resolvers: Array<(result: BodyResult) => void> = [];
		const action = vi.fn(
			() =>
				new Promise<BodyResult>((resolve) => {
					resolvers.push(resolve);
				})
		);
		const client = { action } as unknown as PrefetchClient;
		const { prefetch } = usePostboxPrefetch({
			client,
			debounceMs: 0,
			maxConcurrent: 2,
			maxEntries: 6,
		});

		prefetch(['a', 'b', 'c', 'd']);
		await vi.advanceTimersByTimeAsync(1);
		expect(action).toHaveBeenCalledTimes(2);

		resolvers[0]?.(null);
		await vi.runAllTimersAsync();
		expect(action).toHaveBeenCalledTimes(3);
	});

	it('is a no-op without a Convex client', async () => {
		const { prefetch, size } = usePostboxPrefetch({ client: null, debounceMs: 0 });
		prefetch(['a']);
		await vi.advanceTimersByTimeAsync(1);
		expect(size()).toBe(0);
	});

	it('clear cancels pending work and forgets warm entries', async () => {
		const { client, action } = makeFakeClient();
		const { prefetch, clear, size } = usePostboxPrefetch({ client, debounceMs: 150 });

		prefetch(['a']);
		await vi.advanceTimersByTimeAsync(150);
		expect(size()).toBe(1);
		prefetch(['b']);
		clear();
		await vi.advanceTimersByTimeAsync(150);

		expect(size()).toBe(0);
		expect(action).toHaveBeenCalledTimes(1);
		await resolvePostboxMessageBody(client, 'a');
		expect(action).toHaveBeenCalledTimes(2);
	});
});
