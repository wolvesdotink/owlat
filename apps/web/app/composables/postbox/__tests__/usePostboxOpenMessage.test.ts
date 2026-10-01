/**
 * Plan 2.5: opening a message starts its thread and inline body from the
 * route's message id, in parallel with the list, and the layout's by-id
 * fetch only runs for a message neither the list nor the thread read has.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, type ComputedRef, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { consumeResolvedPostboxMessageBody } from '../postboxBodyResolver';
import {
	usePostboxActiveMessage,
	usePostboxActiveMessageRead,
	usePostboxOpenMessage,
} from '../usePostboxOpenMessage';
import { threadPageArgs } from '../postboxThreadPage';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BODY = 'mail/mailbox/messages:getMessageInlineBody';
const BY_ID = 'mail/mailbox/messages:getMessage';

type Stub = {
	data: Ref<unknown>;
	isLoading: Ref<boolean>;
	error: Ref<Error | null>;
	args: ComputedRef<unknown>;
};
let stubs: Record<string, Stub>;
let blobUrls: ReturnType<typeof vi.fn>;
let download: ReturnType<typeof vi.fn>;
let client: { action: typeof blobUrls; query: ReturnType<typeof vi.fn> };

beforeEach(() => {
	stubs = {};
	blobUrls = vi.fn(async (ref: unknown) => {
		expect(getFunctionName(ref as never)).toBe('mail/mailbox/messages:getMessageBodyBlobUrls');
		return { htmlUrl: 'https://storage.example/html', textUrl: null };
	});
	download = vi.fn(async () => ({ text: async () => '<p>big</p>' }));
	client = { action: blobUrls, query: vi.fn() };
	vi.stubGlobal('useConvex', () => client);
	vi.stubGlobal('fetch', download);
	vi.stubGlobal('useConvexQuery', (query: unknown, args: () => unknown) => {
		const name = getFunctionName(query as never);
		const stub: Stub = {
			data: ref(undefined),
			isLoading: ref(true),
			error: ref(null),
			args: computed(args),
		};
		stubs[name] = stub;
		return { data: stub.data, isLoading: stub.isLoading, error: stub.error, refetch: vi.fn() };
	});
});

function run<T>(fn: () => T): T {
	const result = effectScope().run(fn);
	if (result === undefined) throw new Error('no result');
	return result;
}

function answerThread(messages: Array<{ _id: string }> | null) {
	const thread = stubs[THREAD];
	if (!thread) throw new Error('no thread query');
	thread.data.value = messages === null ? null : { thread: null, labels: [], messages };
	thread.isLoading.value = false;
}

describe('usePostboxOpenMessage', () => {
	it('subscribes the thread and the inline body from the message id at once', () => {
		run(() => usePostboxOpenMessage(ref('m1')));
		// The reader's newest page (plan 3.3), so the reader shares this subscription.
		expect(stubs[THREAD]?.args.value).toEqual(threadPageArgs('m1'));
		expect(stubs[BODY]?.args.value).toEqual({ messageId: 'm1' });
	});

	it('skips both on the folder list', () => {
		run(() => usePostboxOpenMessage(ref(null)));
		expect(stubs[THREAD]?.args.value).toBe('skip');
		expect(stubs[BODY]?.args.value).toBe('skip');
	});

	it('releases the inline body once the thread row, which carries it, is here', () => {
		const { threadMessage } = run(() => usePostboxOpenMessage(ref('m1')));
		answerThread([{ _id: 'm0' }, { _id: 'm1' }]);
		expect(threadMessage.value).toEqual({ _id: 'm1' });
		expect(stubs[BODY]?.args.value).toBe('skip');
	});

	it('starts a blob body download as soon as the inline query reports one', async () => {
		run(() => usePostboxOpenMessage(ref('big')));
		const body = stubs[BODY];
		if (!body) throw new Error('no body query');
		body.data.value = { htmlInline: null, textInline: null, hasHtmlBlob: true, hasTextBlob: false };
		await nextTick();
		expect(blobUrls).toHaveBeenCalledTimes(1);
		expect(blobUrls.mock.calls[0]?.[1]).toEqual({ messageId: 'big' });

		// The reader's body joins that download instead of starting its own.
		expect(
			await consumeResolvedPostboxMessageBody(client as never, 'big', { blobOnly: true })
		).toEqual({ html: '<p>big</p>', text: null });
		expect(blobUrls).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledTimes(1);
	});

	it('never calls the action for an inline body', async () => {
		run(() => usePostboxOpenMessage(ref('small')));
		const body = stubs[BODY];
		if (!body) throw new Error('no body query');
		body.data.value = {
			htmlInline: '<p>hi</p>',
			textInline: null,
			hasHtmlBlob: false,
			hasTextBlob: false,
		};
		await nextTick();
		expect(blobUrls).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
	});
});

describe('usePostboxActiveMessage', () => {
	it('prefers the loaded list row', () => {
		const active = run(() =>
			usePostboxActiveMessage({
				activeMessageId: () => 'm1',
				listRows: () => [{ _id: 'm1', from: 'list' }],
			})
		);
		expect(active.value).toEqual({ _id: 'm1', from: 'list' });
		expect(stubs[BY_ID]?.args.value).toBe('skip');
	});

	it('renders a deep link from its thread row, without a by-id fetch', () => {
		const active = run(() =>
			usePostboxActiveMessage({ activeMessageId: () => 'm1', listRows: () => [] })
		);
		// While the thread loads nothing asks for the message by id.
		expect(stubs[BY_ID]?.args.value).toBe('skip');
		answerThread([{ _id: 'm1' }]);
		expect(active.value).toEqual({ _id: 'm1' });
		expect(stubs[BY_ID]?.args.value).toBe('skip');
	});

	it('fetches by id only when the thread answered without the message', () => {
		const active = run(() =>
			usePostboxActiveMessage({ activeMessageId: () => 'old', listRows: () => [] })
		);
		answerThread([{ _id: 'newer' }]);
		expect(stubs[BY_ID]?.args.value).toEqual({ messageId: 'old' });
		const byId = stubs[BY_ID];
		if (byId) byId.data.value = { _id: 'old', from: 'getMessage' };
		expect(active.value).toEqual({ _id: 'old', from: 'getMessage' });
	});
});

describe('usePostboxActiveMessageRead (#721)', () => {
	it('reports a failed by-id fetch: the message could not be read at all', () => {
		const read = run(() =>
			usePostboxActiveMessageRead({ activeMessageId: () => 'old', listRows: () => [] })
		);
		answerThread([{ _id: 'newer' }]);
		const failure = new Error('[CONVEX Q(mail/mailbox/messages:getMessage)] Server Error');
		stubs[BY_ID]!.error.value = failure;
		expect(read.message.value).toBeUndefined();
		expect(read.error.value).toBe(failure);
	});

	it('ignores the error a skipped fetch kept from the previous message', () => {
		const read = run(() =>
			usePostboxActiveMessageRead({ activeMessageId: () => 'm1', listRows: () => [] })
		);
		// The thread is still loading, so the by-id fetch is skipped.
		stubs[BY_ID]!.error.value = new Error('stale');
		expect(stubs[BY_ID]?.args.value).toBe('skip');
		expect(read.error.value).toBeNull();
	});
});
