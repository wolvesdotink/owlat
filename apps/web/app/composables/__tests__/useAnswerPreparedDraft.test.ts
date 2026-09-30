/**
 * The reply the AI prepared for a thread, read per thread: the clarification
 * draft wins over the draft-on-arrival slot, and nothing is read for a resumed
 * draft (the whole mailbox's queue is never subscribed to for it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useAnswerPreparedDraft } from '../useAnswerPreparedDraft';

vi.mock('@owlat/api', () => ({
	api: { mail: { needsReplyPrepared: { getPreparedDraft: 'getPreparedDraft' } } },
}));

let data: Ref<unknown>;
const calls: Array<{ fn: unknown; args: unknown }> = [];

beforeEach(() => {
	data = ref(undefined);
	calls.length = 0;
	vi.stubGlobal('useConvexQuery', (fn: unknown, args: () => unknown) => {
		calls.push({ fn, args: args() });
		return { data };
	});
});

describe('useAnswerPreparedDraft', () => {
	it('reads the one thread and prefers the clarification draft', () => {
		const { text } = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => true });
		expect(calls).toEqual([{ fn: 'getPreparedDraft', args: { threadId: 'thr_1' } }]);
		data.value = { clarificationDraft: 'With your answers', slotDraft: 'On arrival' };
		expect(text.value).toBe('With your answers');
		data.value = { clarificationDraft: null, slotDraft: 'On arrival' };
		expect(text.value).toBe('On arrival');
	});

	it('reads nothing when not a fresh reply', () => {
		const { text } = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => false });
		expect(calls[0]?.args).toBe('skip');
		expect(text.value).toBeNull();
	});
});
