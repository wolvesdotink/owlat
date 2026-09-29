/**
 * Plan 2.5: opening a message starts its thread and inline body from the
 * route's message id, in parallel with the list, and the layout's by-id
 * fetch only runs for a message neither the list nor the thread read has.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref, type ComputedRef, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { usePostboxActiveMessage, usePostboxOpenMessage } from '../usePostboxOpenMessage';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BODY = 'mail/mailbox/messages:getMessageInlineBody';
const BY_ID = 'mail/mailbox/messages:getMessage';

type Stub = { data: Ref<unknown>; isLoading: Ref<boolean>; args: ComputedRef<unknown> };
let stubs: Record<string, Stub>;

beforeEach(() => {
	stubs = {};
	vi.stubGlobal('useConvexQuery', (query: unknown, args: () => unknown) => {
		const name = getFunctionName(query as never);
		const stub: Stub = { data: ref(undefined), isLoading: ref(true), args: computed(args) };
		stubs[name] = stub;
		return { data: stub.data, isLoading: stub.isLoading, error: ref(null) };
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
		expect(stubs[THREAD]?.args.value).toEqual({ messageId: 'm1' });
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
