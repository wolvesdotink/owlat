// @vitest-environment happy-dom
/**
 * usePostboxCursorFeed — keyset accumulation semantics.
 *
 * Pins the behaviors the Postbox lists depend on:
 *   1. "Load more" appends a cursor-keyed tail page (deduped by _id).
 *   2. THE REGRESSION GUARD: the first page stays live after deeper pages are
 *      loaded — new mail re-emitting page 1 floats to the TOP of the list.
 *   3. A resetKey change restarts from a fresh first page.
 *   4. hasMore follows the active frontier (first page before any Load more,
 *      the tail afterwards).
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, defineComponent, h, nextTick, type Ref } from 'vue';

import { usePostboxCursorFeed } from '../../../composables/postbox/usePostboxCursorFeed';

type Row = { _id: string; subject: string };

/**
 * Scripted fake of the Convex live-query subscription. The composable creates
 * two subscriptions — the always-live first page and the cursor-keyed tail —
 * so the fake routes each useConvexQuery call by whether its resolved args
 * carry a cursor ('skip' ⇒ the not-yet-active tail).
 */
let emitFirst: ((rows: Row[], nextCursor: string | null) => void) | null = null;
let emitTail: ((rows: Row[], nextCursor: string | null) => void) | null = null;

function stubConvexQuery() {
	vi.stubGlobal('useConvexQuery', (_query: unknown, argsFactory: () => unknown) => {
		const data = ref<unknown>(undefined);
		const isLoading = ref(true);
		const resolved = argsFactory();
		const isTail = resolved === 'skip' || ((resolved as { cursor?: string })['cursor'] ?? null);
		const emit = (rows: Row[], nextCursor: string | null) => {
			data.value = { messages: rows, hasMore: nextCursor !== null, nextCursor };
			isLoading.value = false;
		};
		if (isTail) emitTail = emit;
		else emitFirst = emit;
		return { data, isLoading, isRefetching: ref(false), error: ref(null), refetch: () => {} };
	});
}

function mountFeed(resetKey: Ref<string>) {
	let feed: ReturnType<typeof usePostboxCursorFeed> | null = null;
	const Comp = defineComponent({
		setup() {
			// Auto-imports resolve to the stubbed globals above.
			feed = usePostboxCursorFeed({} as never, () => ({ limit: 2 }) as never, resetKey, {
				keepPreviousData: true,
			});
			return () =>
				h(
					'ul',
					(feed!.rows as Ref<Row[]>).value.map((r) => h('li', { key: r._id }, r.subject))
				);
		},
	});
	return { wrapper: mount(Comp), feed: feed! };
}

describe('usePostboxCursorFeed', () => {
	it('appends cursor-keyed tail pages deduped', async () => {
		stubConvexQuery();
		const resetKey = ref('inbox');
		const { wrapper, feed } = mountFeed(resetKey);

		emitFirst!(
			[
				{ _id: 'a', subject: 'A' },
				{ _id: 'b', subject: 'B' },
			],
			'cursor-1'
		);
		await nextTick();
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['A', 'B']);

		feed.loadMore();
		emitTail!(
			[
				{ _id: 'c', subject: 'C' },
				{ _id: 'b', subject: 'B (dup)' },
			],
			null
		);
		await nextTick();
		// The duplicate `b` (already shown by the first page) is dropped.
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['A', 'B', 'C']);
	});

	it('keeps the first page live: new mail floats to the top after paging', async () => {
		stubConvexQuery();
		const resetKey = ref('inbox');
		const { wrapper, feed } = mountFeed(resetKey);

		emitFirst!([{ _id: 'b', subject: 'B' }], 'cursor-1');
		await nextTick();
		feed.loadMore();
		emitTail!([{ _id: 'old', subject: 'Old A' }], null);
		await nextTick();
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['B', 'Old A']);

		// New mail arrives: the live first page re-emits with the new row FIRST.
		// It must land at the top of the rendered list, above the loaded tail.
		emitFirst!(
			[
				{ _id: 'new', subject: 'New mail' },
				{ _id: 'b', subject: 'B' },
			],
			'cursor-1'
		);
		await nextTick();
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['New mail', 'B', 'Old A']);
	});

	it('restarts from a fresh first page when the resetKey changes', async () => {
		stubConvexQuery();
		const resetKey = ref('inbox');
		const { wrapper, feed } = mountFeed(resetKey);

		emitFirst!([{ _id: 'a', subject: 'A' }], 'cursor-1');
		await nextTick();
		feed.loadMore();
		emitTail!([{ _id: 'b', subject: 'B' }], null);
		await nextTick();
		expect(wrapper.findAll('li')).toHaveLength(2);

		resetKey.value = 'sent';
		await nextTick();
		await nextTick();
		// Accumulated segments dropped synchronously; the scripted subscription
		// then delivers the new view's first page.
		emitFirst!([{ _id: 's', subject: 'Sent mail' }], null);
		await nextTick();
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['Sent mail']);
	});

	it('reports hasMore from the active frontier', async () => {
		stubConvexQuery();
		const resetKey = ref('inbox');
		const { feed } = mountFeed(resetKey);

		emitFirst!([{ _id: 'a', subject: 'A' }], 'cursor-1');
		await nextTick();
		expect(feed.hasMore.value).toBe(true);

		feed.loadMore();
		emitTail!([{ _id: 'b', subject: 'B' }], null);
		await nextTick();
		expect(feed.hasMore.value).toBe(false);
	});
});
