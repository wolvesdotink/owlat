/**
 * Plan 3.3: the reader reads a long thread in pages. The newest page comes
 * with the newest bodies, older messages as envelopes, earlier pages load on
 * demand (or by themselves to reach the opened message), and an expanded
 * envelope loads its own body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	computed,
	effectScope,
	nextTick,
	onScopeDispose,
	reactive,
	ref,
	shallowReactive,
	type ComputedRef,
} from 'vue';
import { getFunctionName } from 'convex/server';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import {
	THREAD_ANCHOR_PAGE_LIMIT,
	earlierThreadPageArgs,
	threadPageArgs,
} from '../postboxThreadPage';
import { usePostboxEnvelopeBodies, usePostboxThreadPages } from '../usePostboxThreadPages';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BODY = 'mail/mailbox/messages:getMessageInlineBody';

type Sub = { name: string; args: ComputedRef<unknown>; closed: boolean };
let subs: Sub[];
const answers = reactive(new Map<string, unknown>());
const failures = reactive(new Set<string>());
const refetch = vi.fn();

const keyOf = (name: string, args: unknown) => `${name}|${JSON.stringify(args)}`;

beforeEach(() => {
	subs = [];
	answers.clear();
	failures.clear();
	refetch.mockClear();
	vi.stubGlobal('shallowReactive', shallowReactive);
	vi.stubGlobal('useConvexQueryMap', useConvexQueryMap);
	vi.stubGlobal('useConvexQuery', (query: unknown, args: () => unknown) => {
		const name = getFunctionName(query as never);
		const sub: Sub = { name, args: computed(args), closed: false };
		subs.push(sub);
		onScopeDispose(() => {
			sub.closed = true;
		});
		const key = computed(() => (sub.args.value === 'skip' ? null : keyOf(name, sub.args.value)));
		return {
			data: computed(() => (key.value ? answers.get(key.value) : undefined)),
			error: computed(() => (key.value && failures.has(key.value) ? new Error('down') : null)),
			isLoading: computed(() => !key.value || !answers.has(key.value)),
			refetch,
		};
	});
});

/** Args of every live subscription of `name` that is not skipped. */
function live(name: string): unknown[] {
	return subs
		.filter((s) => s.name === name && !s.closed && s.args.value !== 'skip')
		.map((s) => s.args.value);
}

function row(id: string, receivedAt: number, extra: Record<string, unknown> = {}) {
	return { _id: id, receivedAt, fromAddress: 'ines@example.com', flagSeen: true, ...extra };
}

function page(
	messages: ReturnType<typeof row>[],
	envelopes: ReturnType<typeof row>[],
	olderCursor: string | null,
	thread: Record<string, unknown> = { _id: 't1', messageCount: 9, unreadCount: 0 }
) {
	return { thread, labels: [], messages, envelopes, olderCursor };
}

function answerNewest(messageId: string, value: unknown) {
	answers.set(keyOf(THREAD, threadPageArgs(messageId)), value);
}
function answerEarlier(messageId: string, cursor: string, value: unknown) {
	answers.set(keyOf(THREAD, earlierThreadPageArgs(messageId, cursor)), value);
}

function mountPages(messageId = 'm9', threadKey = 't1') {
	const id = ref(messageId);
	const key = ref(threadKey);
	const scope = effectScope();
	const pages = scope.run(() =>
		usePostboxThreadPages({ messageId: () => id.value, threadKey: () => key.value })
	);
	if (!pages) throw new Error('no pages');
	return { pages, id, key, scope };
}

const ids = (rows: Array<{ _id: string }> | undefined) => rows?.map((r) => r._id);

describe('usePostboxThreadPages', () => {
	it('reads the newest page with the args the open route and the read-ahead share', () => {
		mountPages('m9');
		expect(live(THREAD)).toEqual([threadPageArgs('m9')]);
	});

	it('merges the newest page oldest first and loads an earlier page only when asked', async () => {
		const { pages } = mountPages('m9');
		answerNewest('m9', page([row('m8', 8), row('m9', 9)], [row('m6', 6), row('m7', 7)], 'c1'));
		await nextTick();

		expect(ids(pages.rows.value)).toEqual(['m6', 'm7', 'm8', 'm9']);
		expect([...pages.bodyIds.value]).toEqual(['m8', 'm9']);
		expect(pages.hasEarlier.value).toBe(true);
		expect(pages.startsThread.value).toBe(false);
		expect(live(THREAD)).toHaveLength(1);

		pages.loadEarlier();
		await nextTick();
		expect(live(THREAD)).toContainEqual(earlierThreadPageArgs('m9', 'c1'));
		expect(pages.loadingEarlier.value).toBe(true);

		answerEarlier(
			'm9',
			'c1',
			page(
				[],
				[1, 2, 3, 4, 5].map((n) => row(`m${n}`, n)),
				null
			)
		);
		await nextTick();
		expect(ids(pages.rows.value)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
		expect(pages.loadingEarlier.value).toBe(false);
		expect(pages.hasEarlier.value).toBe(false);
	});

	it('keeps the newer page copy of a message both pages hold after a reply shifted them', async () => {
		const { pages } = mountPages('m9');
		const shifted = row('m6', 6, { textBodyInline: 'from the newest page' });
		answerNewest('m9', page([row('m9', 9)], [shifted], 'c1'));
		await nextTick();
		pages.loadEarlier();
		answerEarlier('m9', 'c1', page([], [row('m5', 5), row('m6', 6)], null));
		await nextTick();

		expect(ids(pages.rows.value)).toEqual(['m5', 'm6', 'm9']);
		expect(pages.rows.value?.[1]).toMatchObject({ textBodyInline: 'from the newest page' });
	});

	it('walks back to the opened message when the newest page does not hold it', async () => {
		const { pages } = mountPages('m2');
		answerNewest('m2', page([row('m9', 9)], [row('m8', 8)], 'c1'));
		await nextTick();
		expect(live(THREAD)).toContainEqual(earlierThreadPageArgs('m2', 'c1'));

		answerEarlier('m2', 'c1', page([], [row('m2', 2), row('m3', 3)], 'c2'));
		await nextTick();
		expect(ids(pages.rows.value)).toEqual(['m2', 'm3', 'm8', 'm9']);
		// Found: no further page, though the thread goes back further.
		expect(live(THREAD)).not.toContainEqual(earlierThreadPageArgs('m2', 'c2'));
		expect(pages.hasEarlier.value).toBe(true);
	});

	it('bounds that walk', async () => {
		mountPages('gone');
		answerNewest('gone', page([row('m99', 99)], [], 'c0'));
		for (let i = 0; i < THREAD_ANCHOR_PAGE_LIMIT + 3; i++) {
			answerEarlier('gone', `c${i}`, page([], [row(`e${i}`, 50 - i)], `c${i + 1}`));
		}
		for (let i = 0; i < THREAD_ANCHOR_PAGE_LIMIT * 3; i++) await nextTick();
		expect(live(THREAD)).toHaveLength(THREAD_ANCHOR_PAGE_LIMIT + 1);
	});

	it('reports a failed earlier page and retries it from the same control', async () => {
		const { pages } = mountPages('m9');
		answerNewest('m9', page([row('m9', 9)], [], 'c1'));
		await nextTick();
		failures.add(keyOf(THREAD, earlierThreadPageArgs('m9', 'c1')));
		pages.loadEarlier();
		await nextTick();

		expect(pages.earlierFailed.value).toBe(true);
		expect(pages.loadingEarlier.value).toBe(false);
		pages.loadEarlier();
		expect(refetch).toHaveBeenCalledTimes(1);
		// A retry asks for the same page, not the one after it.
		expect(live(THREAD)).toHaveLength(2);
	});

	it('counts unread mail in pages not loaded yet from the thread row', async () => {
		const { pages } = mountPages('m9');
		answerNewest(
			'm9',
			page([row('m9', 9)], [], 'c1', { _id: 't1', messageCount: 60, unreadCount: 2 })
		);
		await nextTick();
		expect(pages.hasUnread.value).toBe(true);

		answerNewest(
			'm9',
			page([row('m9', 9)], [], null, { _id: 't1', messageCount: 1, unreadCount: 2 })
		);
		await nextTick();
		// The whole thread is loaded and read: the loaded rows are the truth.
		expect(pages.hasUnread.value).toBe(false);
	});

	it('drops the earlier pages when another thread opens', async () => {
		const { pages, id, key } = mountPages('m9');
		answerNewest('m9', page([row('m9', 9)], [], 'c1'));
		await nextTick();
		pages.loadEarlier();
		await nextTick();
		expect(live(THREAD)).toHaveLength(2);

		id.value = 'x1';
		key.value = 't2';
		await nextTick();
		expect(live(THREAD)).toEqual([threadPageArgs('x1')]);
	});
});

describe('usePostboxEnvelopeBodies', () => {
	function mountBodies(rows: Array<ReturnType<typeof row>>, bodyIds: string[]) {
		const expanded = ref(new Set<string>());
		const scope = effectScope();
		const out = scope.run(() =>
			usePostboxEnvelopeBodies({
				rows: () => rows,
				expanded: () => expanded.value,
				bodyIds: () => new Set(bodyIds),
			})
		);
		if (!out) throw new Error('no bodies');
		return { out, expanded };
	}

	it('loads the body of an expanded envelope only, and releases it on collapse', async () => {
		const withBody = row('m9', 9, { textBodyInline: 'Newest' });
		const { out, expanded } = mountBodies([row('m1', 1), row('m2', 2), withBody], ['m9']);
		expect(live(BODY)).toEqual([]);

		expanded.value = new Set(['m1', 'm9']);
		await nextTick();
		expect(live(BODY)).toEqual([{ messageId: 'm1' }]);
		expect(out.value?.[0]).toMatchObject({ _id: 'm1', bodyPending: true });
		expect(out.value?.[2]).toBe(withBody);

		answers.set(keyOf(BODY, { messageId: 'm1' }), {
			htmlInline: null,
			textInline: 'The first message',
			hasHtmlBlob: false,
			hasTextBlob: false,
		});
		await nextTick();
		expect(out.value?.[0]).toMatchObject({ textBodyInline: 'The first message' });
		expect(out.value?.[0]).not.toHaveProperty('bodyPending');

		expanded.value = new Set(['m9']);
		await nextTick();
		expect(live(BODY)).toEqual([]);
	});
});
