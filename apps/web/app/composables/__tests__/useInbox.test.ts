import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';
import { useInbox } from '../useInbox';

/**
 * Regression tests for the inbox pagination wiring (FRONTEND_WIRING_REVIEW H1):
 * - "Load More" must APPEND pages, not replace the visible list.
 * - A filter change must reset the keyset cursor (it is minted against a
 *   filter-specific backend index, so reusing it is invalid).
 */
describe('useInbox pagination', () => {
	// One controllable { data } per useConvexQuery call, in call order.
	let created: Array<{ data: Ref<unknown>; args: () => unknown }> = [];

	beforeEach(() => {
		created = [];
		vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
			const handle = { data: ref<unknown>(undefined), isLoading: ref(false), args };
			created.push(handle);
			return handle;
		});
		vi.stubGlobal('formatCompactRelativeTime', () => 'just now');
		// The composable mirrors the filter into the URL and persists the sort
		// choice; stub the Nuxt/localStorage seams the pagination logic doesn't care
		// about so the accumulator behaviour can be exercised in isolation.
		vi.stubGlobal('useRoute', () => ({ query: {} }));
		vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }));
		vi.stubGlobal('useLocalStorage', (_key: string, def: unknown) => ({
			data: ref(def),
			set: vi.fn(),
		}));
	});

	const thread = (id: string) => ({ _id: id, status: 'open', lastMessageAt: 1 });

	it('appends pages on loadMoreThreads instead of replacing them', async () => {
		const { threads, hasMoreThreads, loadMoreThreads } = useInbox();
		const threadsData = created[0]!.data;

		// First page (cursor undefined) replaces.
		threadsData.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		expect(threads.value.map((t) => t._id)).toEqual(['a', 'b']);
		expect(hasMoreThreads.value).toBe(true);

		// Advance the cursor, then deliver the next page — it must append.
		loadMoreThreads();
		threadsData.value = { threads: [thread('c'), thread('d')], nextCursor: null };
		await nextTick();
		expect(threads.value.map((t) => t._id)).toEqual(['a', 'b', 'c', 'd']);
		expect(hasMoreThreads.value).toBe(false);
	});

	it('dedupes overlapping rows across pages', async () => {
		const { threads, loadMoreThreads } = useInbox();
		const threadsData = created[0]!.data;

		threadsData.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		threadsData.value = { threads: [thread('b'), thread('c')], nextCursor: null };
		await nextTick();
		expect(threads.value.map((t) => t._id)).toEqual(['a', 'b', 'c']);
	});

	it('resets accumulated pages and cursor when a filter changes', async () => {
		const { threads, filter, loadMoreThreads } = useInbox();
		const threadsData = created[0]!.data;

		threadsData.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		threadsData.value = { threads: [thread('c')], nextCursor: null };
		await nextTick();
		expect(threads.value).toHaveLength(3);

		// Changing the filter must clear the accumulator immediately (sync watch),
		// so the next first page replaces rather than appends.
		filter.value = 'resolved';
		expect(threads.value).toHaveLength(0);

		threadsData.value = { threads: [thread('x')], nextCursor: null };
		await nextTick();
		expect(threads.value.map((t) => t._id)).toEqual(['x']);
	});

	it('sends the assignment filter to the list and the tab counts', () => {
		const { assignee, threads, loadMoreThreads } = useInbox();
		const [list, counts] = created;
		expect(list!.args()).not.toHaveProperty('assignee');
		expect(counts!.args()).toEqual({});

		assignee.value = 'me';
		expect(list!.args()).toMatchObject({ filter: 'open', assignee: 'me' });
		expect(counts!.args()).toEqual({ assignee: 'me' });
		expect(threads.value).toHaveLength(0);
		expect(typeof loadMoreThreads).toBe('function');
	});

	it('reads an old ?filter=mine link as Open, assigned to me', () => {
		vi.stubGlobal('useRoute', () => ({ query: { filter: 'mine' } }));
		const { filter, assignee } = useInbox();
		expect(filter.value).toBe('open');
		expect(assignee.value).toBe('me');
	});

	it('applies a legacy waiting-24h sort to this view without saving it', () => {
		const set = vi.fn();
		vi.stubGlobal('useRoute', () => ({ query: { filter: 'waiting-24h' } }));
		vi.stubGlobal('useLocalStorage', (_key: string, def: unknown) => ({ data: ref(def), set }));
		const { sort, setSort } = useInbox();

		expect(sort.value).toBe('oldest-waiting');
		expect(created[0]!.args()).toMatchObject({ sort: 'oldest-waiting' });
		expect(set).not.toHaveBeenCalled();

		// Picking a sort is a real choice: it is saved and ends the override.
		setSort('newest');
		expect(set).toHaveBeenCalledWith('newest');
	});
});
