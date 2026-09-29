import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { getFunctionName } from 'convex/server';
import { SUBSCRIPTION_LINGER_MS } from '~/lib/sharedConvexSubscriptions';
import { consumeResolvedPostboxMessageBody } from '../postboxBodyResolver';
import { threadPageArgs } from '../postboxThreadPage';
import {
	inlineBodyNeedsBlob,
	usePostboxPrefetch,
	type PrefetchClient,
} from '../usePostboxPrefetch';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BODY = 'mail/mailbox/messages:getMessageInlineBody';

type InlineBody = {
	htmlInline: string | null;
	textInline: string | null;
	hasHtmlBlob: boolean;
	hasTextBlob: boolean;
};

interface FakeSubscription {
	name: string;
	messageId: string;
	deliver: (value: unknown) => void;
	closed: boolean;
}

/**
 * A client that records every transport subscription (the holds open them
 * through the shared registry) and answers the blob URL action.
 */
function makeFakeClient(
	blobAction: (messageId: string) => Promise<unknown> = async () => ({
		htmlUrl: 'https://storage.example/signed-html',
		textUrl: null,
	})
) {
	const subscriptions: FakeSubscription[] = [];
	const onUpdate = vi.fn(
		(ref: unknown, args: { messageId: string }, callback: (value: unknown) => void) => {
			const sub: FakeSubscription = {
				name: getFunctionName(ref as never),
				messageId: args.messageId,
				deliver: callback,
				closed: false,
			};
			subscriptions.push(sub);
			return () => {
				sub.closed = true;
			};
		}
	);
	const action = vi.fn((_ref: unknown, args: { messageId: string }) => blobAction(args.messageId));
	const query = vi.fn(async () => null);
	const client = { onUpdate, action, query } as unknown as PrefetchClient;
	const open = (name: string) =>
		subscriptions.filter((s) => s.name === name && !s.closed).map((s) => s.messageId);
	const find = (name: string, messageId: string) =>
		subscriptions.find((s) => s.name === name && s.messageId === messageId && !s.closed);
	return { client, onUpdate, action, subscriptions, open, find };
}

const blobBody: InlineBody = {
	htmlInline: null,
	textInline: null,
	hasHtmlBlob: true,
	hasTextBlob: false,
};
const inlineBody: InlineBody = {
	htmlInline: '<p>hi</p>',
	textInline: null,
	hasHtmlBlob: false,
	hasTextBlob: false,
};

describe('usePostboxPrefetch', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('holds the thread and inline body queries only after the debounce window', async () => {
		const fake = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client: fake.client, debounceMs: 150 });

		prefetch(['next-id', 'prev-id']);
		await vi.advanceTimersByTimeAsync(149);
		expect(fake.onUpdate).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(fake.open(THREAD)).toEqual(['next-id', 'prev-id']);
		expect(fake.open(BODY)).toEqual(['next-id', 'prev-id']);
	});

	it("holds the thread's newest page with the reader's args, so the reader joins it (plan 3.3)", async () => {
		const fake = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client: fake.client, debounceMs: 150 });

		prefetch(['next-id']);
		await vi.advanceTimersByTimeAsync(150);
		const threadArgs = fake.onUpdate.mock.calls
			.filter(([ref]) => getFunctionName(ref as never) === THREAD)
			.map(([, args]) => args);
		expect(threadArgs).toEqual([threadPageArgs('next-id')]);
	});

	it('coalesces rapid focus changes so only the last targets are held', async () => {
		const fake = makeFakeClient();
		const { prefetch } = usePostboxPrefetch({ client: fake.client, debounceMs: 150 });

		prefetch(['b', 'a']);
		await vi.advanceTimersByTimeAsync(100);
		prefetch(['c', 'b']);
		await vi.advanceTimersByTimeAsync(100);
		prefetch(['d', 'c']);
		expect(fake.onUpdate).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(150);
		expect(fake.open(THREAD)).toEqual(['d', 'c']);
	});

	it('skips ids that are already warm and ignores list edges', async () => {
		const fake = makeFakeClient();
		const { prefetch, isWarm } = usePostboxPrefetch({ client: fake.client, debounceMs: 0 });

		prefetch(['a', undefined, null]);
		await vi.advanceTimersByTimeAsync(1);
		prefetch(['a']);
		await vi.advanceTimersByTimeAsync(1);

		expect(fake.onUpdate).toHaveBeenCalledTimes(2);
		expect(isWarm('a')).toBe(true);
	});

	it('releases the least-recently-used holds, which then close after the linger', async () => {
		const fake = makeFakeClient();
		const { prefetch, isWarm, size } = usePostboxPrefetch({
			client: fake.client,
			debounceMs: 0,
			maxEntries: 3,
		});

		for (const id of ['a', 'b', 'c', 'a', 'd', 'e']) {
			prefetch([id]);
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(size()).toBe(3);
		expect(['a', 'd', 'e'].every(isWarm)).toBe(true);
		expect(isWarm('b') || isWarm('c')).toBe(false);

		// Released, not closed: the registry keeps them warm for its linger.
		expect(fake.open(THREAD)).toEqual(['a', 'b', 'c', 'd', 'e']);
		await vi.advanceTimersByTimeAsync(SUBSCRIPTION_LINGER_MS);
		expect(fake.open(THREAD)).toEqual(['a', 'd', 'e']);
		expect(fake.open(BODY)).toEqual(['a', 'd', 'e']);
	});

	it('never calls the action for an inline body', async () => {
		const fake = makeFakeClient();
		const fetchImpl = vi.fn();
		const { prefetch } = usePostboxPrefetch({ client: fake.client, fetchImpl, debounceMs: 0 });

		prefetch(['inline-msg']);
		await vi.advanceTimersByTimeAsync(1);
		fake.find(BODY, 'inline-msg')?.deliver(inlineBody);
		await vi.advanceTimersByTimeAsync(1);

		expect(fake.action).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('resolves a blob body the query reports and shares it with the reader', async () => {
		const fake = makeFakeClient();
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('body') }));
		const { prefetch } = usePostboxPrefetch({ client: fake.client, fetchImpl, debounceMs: 0 });

		prefetch(['blob-msg']);
		await vi.advanceTimersByTimeAsync(1);
		fake.find(BODY, 'blob-msg')?.deliver(blobBody);
		// A live update of the same answer does not queue a second download.
		fake.find(BODY, 'blob-msg')?.deliver(blobBody);
		await vi.advanceTimersByTimeAsync(1);

		const resolved = await consumeResolvedPostboxMessageBody(fake.client, 'blob-msg', {
			fetchImpl,
			blobOnly: true,
		});
		expect(resolved).toEqual({ html: 'body', text: null });
		expect(fake.action).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith('https://storage.example/signed-html');
	});

	it('swallows blob failures and retries when the query reports the blob again', async () => {
		const blobAction = vi
			.fn()
			.mockRejectedValueOnce(new Error('action unavailable'))
			.mockResolvedValueOnce({ htmlUrl: 'https://storage.example/signed-html', textUrl: null });
		const fake = makeFakeClient(blobAction);
		const fetchImpl = vi.fn(() => Promise.resolve({ text: () => Promise.resolve('body') }));
		const { prefetch, isWarm } = usePostboxPrefetch({
			client: fake.client,
			fetchImpl,
			debounceMs: 0,
		});

		prefetch(['err-msg']);
		await vi.advanceTimersByTimeAsync(1);
		fake.find(BODY, 'err-msg')?.deliver(blobBody);
		await vi.advanceTimersByTimeAsync(1);
		expect(isWarm('err-msg')).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();

		fake.find(BODY, 'err-msg')?.deliver(blobBody);
		await vi.advanceTimersByTimeAsync(1);
		expect(blobAction).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('never exceeds the configured action concurrency', async () => {
		const resolvers: Array<(value: unknown) => void> = [];
		const fake = makeFakeClient(
			() =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				})
		);
		const { prefetch } = usePostboxPrefetch({
			client: fake.client,
			debounceMs: 0,
			maxConcurrent: 2,
			maxEntries: 6,
		});

		prefetch(['a', 'b', 'c', 'd']);
		await vi.advanceTimersByTimeAsync(1);
		for (const id of ['a', 'b', 'c', 'd']) fake.find(BODY, id)?.deliver(blobBody);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.action).toHaveBeenCalledTimes(2);

		resolvers[0]?.(null);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.action).toHaveBeenCalledTimes(3);
	});

	it('cancels pending warm-ups and releases its holds when the list unmounts', async () => {
		const fake = makeFakeClient();
		const scope = effectScope();
		const prefetcher = scope.run(() => usePostboxPrefetch({ client: fake.client, debounceMs: 0 }));
		prefetcher?.prefetch(['held']);
		await vi.advanceTimersByTimeAsync(1);
		prefetcher?.prefetch(['late']);
		scope.stop();

		await vi.advanceTimersByTimeAsync(1);
		expect(fake.open(THREAD)).toEqual(['held']);
		await vi.advanceTimersByTimeAsync(SUBSCRIPTION_LINGER_MS);
		expect(fake.open(THREAD)).toEqual([]);
	});

	it('clear forgets warm entries', async () => {
		const fake = makeFakeClient();
		const { prefetch, clear, size } = usePostboxPrefetch({ client: fake.client, debounceMs: 0 });

		prefetch(['a']);
		await vi.advanceTimersByTimeAsync(1);
		expect(size()).toBe(1);
		clear();
		expect(size()).toBe(0);
	});

	it('is a no-op without a Convex client', async () => {
		const { prefetch, size } = usePostboxPrefetch({ client: null, debounceMs: 0 });
		prefetch(['a']);
		await vi.advanceTimersByTimeAsync(1);
		expect(size()).toBe(0);
	});
});

describe('inlineBodyNeedsBlob', () => {
	it('is true only when there is no inline body but a blob', () => {
		expect(inlineBodyNeedsBlob(blobBody)).toBe(true);
		expect(inlineBodyNeedsBlob({ ...blobBody, hasHtmlBlob: false, hasTextBlob: true })).toBe(true);
		expect(inlineBodyNeedsBlob(inlineBody)).toBe(false);
		expect(inlineBodyNeedsBlob({ ...blobBody, textInline: 'short' })).toBe(false);
		expect(inlineBodyNeedsBlob({ ...blobBody, hasHtmlBlob: false })).toBe(false);
		expect(inlineBodyNeedsBlob(null)).toBe(false);
		expect(inlineBodyNeedsBlob(undefined)).toBe(false);
	});
});
