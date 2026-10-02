import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';
import { useInbox } from '../useInbox';

/**
 * Regression tests for the inbox pagination wiring (FRONTEND_WIRING_REVIEW H1):
 * - "Load More" must APPEND pages, not replace the visible list.
 * - The first page stays live after "Load More" (it never takes a cursor), so
 *   new threads keep reaching the top.
 * - A filter change must drop every keyset cursor (each is minted against a
 *   filter-specific backend index, so reusing it is invalid).
 */
describe('useInbox pagination', () => {
	// One controllable { data } per useConvexQuery call, in call order.
	let created: Array<{
		data: Ref<unknown>;
		isRefetching: Ref<boolean>;
		error: Ref<Error | null>;
		refetch: ReturnType<typeof vi.fn>;
		args: () => unknown;
		options: unknown;
	}> = [];

	beforeEach(() => {
		created = [];
		vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown, options?: unknown) => {
			const handle = {
				data: ref<unknown>(undefined),
				isLoading: ref(false),
				isRefetching: ref(false),
				error: ref<Error | null>(null),
				refetch: vi.fn(),
				args,
				options,
			};
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

	const thread = (id: string, status = 'open') => ({ _id: id, status, lastMessageAt: 1 });
	// Call order inside useInbox: list first page, list tail, filter counts, stats.
	const handles = () => {
		const [first, tail, counts] = created;
		return { first: first!, tail: tail!, counts: counts! };
	};
	const ids = (rows: Array<{ _id: string }>) => rows.map((t) => t._id);

	it('appends pages on loadMoreThreads instead of replacing them', async () => {
		const { threads, hasMoreThreads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b']);
		expect(hasMoreThreads.value).toBe(true);
		expect(tail.args()).toBe('skip');

		// Load more opens the tail on the first page's cursor; its page appends.
		loadMoreThreads();
		expect(tail.args()).toMatchObject({ cursor: 'c1', limit: 25 });
		expect(hasMoreThreads.value).toBe(false);
		tail.data.value = { threads: [thread('c'), thread('d')], nextCursor: null };
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b', 'c', 'd']);
		expect(hasMoreThreads.value).toBe(false);
	});

	it('retries only the page that failed, never reloading the whole list (#1098)', async () => {
		const { threadsError, retryThreads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.error.value = new Error('tail page failed');
		expect(threadsError.value).toBe(tail.error.value);

		retryThreads();
		expect(tail.refetch).toHaveBeenCalledTimes(1);
		expect(first.refetch).not.toHaveBeenCalled();

		tail.error.value = null;
		first.error.value = new Error('first page failed');
		retryThreads();
		expect(first.refetch).toHaveBeenCalledTimes(1);
		expect(tail.refetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the first page live after load more, so new threads still reach the top', async () => {
		const { threads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.data.value = { threads: [thread('c')], nextCursor: null };
		await nextTick();

		// The first page never carries a cursor: it is the same live subscription.
		expect(first.args()).not.toHaveProperty('cursor');

		// A new thread arrives and a thread on the first page is resolved.
		first.data.value = { threads: [thread('new'), thread('a')], nextCursor: 'c1b' };
		await nextTick();
		expect(ids(threads.value)).toEqual(['new', 'a', 'c']);
	});

	it('keeps earlier tail pages when paging deeper', async () => {
		const { threads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.data.value = { threads: [thread('b')], nextCursor: 'c2' };
		await nextTick();
		loadMoreThreads();
		expect(tail.args()).toMatchObject({ cursor: 'c2' });
		tail.data.value = { threads: [thread('c')], nextCursor: null };
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b', 'c']);
	});

	it('dedupes overlapping rows across pages, preferring the live first page', async () => {
		const { threads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.data.value = { threads: [thread('b', 'resolved'), thread('c')], nextCursor: null };
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b', 'c']);
		expect(threads.value[1]!.status).toBe('open');
	});

	it('drops the tail on a filter change but keeps the rows until the new first page', async () => {
		const { threads, filter, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a'), thread('b')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.data.value = { threads: [thread('c')], nextCursor: null };
		await nextTick();
		expect(threads.value).toHaveLength(3);

		// Every cursor is invalid for the new view: the tail unsubscribes at once…
		filter.value = 'resolved';
		expect(tail.args()).toBe('skip');
		expect(first.args()).toMatchObject({ filter: 'resolved' });
		expect(first.args()).not.toHaveProperty('cursor');
		// …but while the new first page loads, the list does not shrink or blank.
		first.isRefetching.value = true;
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b', 'c']);

		first.data.value = { threads: [thread('x')], nextCursor: null };
		first.isRefetching.value = false;
		await nextTick();
		expect(ids(threads.value)).toEqual(['x']);
	});

	it('drops the retained rows at once when the new first page is answered from cache', async () => {
		const { threads, filter, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		first.data.value = { threads: [thread('a')], nextCursor: 'c1' };
		await nextTick();
		loadMoreThreads();
		tail.data.value = { threads: [thread('b')], nextCursor: null };
		await nextTick();

		// The new view's first page lands in the same tick: no refetch is shown.
		filter.value = 'resolved';
		first.data.value = { threads: [thread('x')], nextCursor: null };
		await nextTick();
		expect(ids(threads.value)).toEqual(['x']);

		// A later background refetch must not bring the old view's rows back.
		first.isRefetching.value = true;
		await nextTick();
		expect(ids(threads.value)).toEqual(['x']);
	});

	it('lands a tail page replayed from a warm subscription as the same object', async () => {
		const { threads, filter, hasMoreThreads, loadMoreThreads } = useInbox();
		const { first, tail } = handles();

		const firstPage = { threads: [thread('a')], nextCursor: 'c1' };
		const tailPage = { threads: [thread('b')], nextCursor: null };
		first.data.value = firstPage;
		await nextTick();
		loadMoreThreads();
		tail.data.value = tailPage;
		await nextTick();

		// Away and back: a skipped tail keeps its last value, as the real query does.
		filter.value = 'resolved';
		await nextTick();
		filter.value = 'open';
		await nextTick();
		expect(ids(threads.value)).toEqual(['a']);

		// The same cursor again: the lingering subscription clears, then hands
		// back the very same page object within one re-subscribe.
		loadMoreThreads();
		expect(tail.args()).toMatchObject({ cursor: 'c1' });
		tail.data.value = undefined;
		tail.data.value = tailPage;
		await nextTick();
		expect(ids(threads.value)).toEqual(['a', 'b']);
		expect(hasMoreThreads.value).toBe(false);
	});

	it('keeps the first page and the counts across filter, assignee and sort changes', () => {
		useInbox();
		const { first, counts } = handles();
		expect(first.options).toEqual({ keepPreviousData: true });
		expect(counts.options).toEqual({ keepPreviousData: true });
	});

	it('offers no "load more" from the previous view while the new one loads', async () => {
		const { hasMoreThreads, loadMoreThreads, filter } = useInbox();
		const { first, tail } = handles();
		first.data.value = { threads: [thread('a')], nextCursor: 'old-view-cursor' };
		await nextTick();
		expect(hasMoreThreads.value).toBe(true);

		filter.value = 'resolved';
		first.isRefetching.value = true;
		expect(hasMoreThreads.value).toBe(false);
		loadMoreThreads();
		expect(tail.args()).toBe('skip');
	});

	it('sends the assignment filter to the list and the tab counts', () => {
		const { assignee, threads, loadMoreThreads } = useInbox();
		const { first: list, counts } = handles();
		expect(list.args()).not.toHaveProperty('assignee');
		expect(counts.args()).toEqual({});

		assignee.value = 'me';
		expect(list.args()).toMatchObject({ filter: 'open', assignee: 'me' });
		expect(counts.args()).toEqual({ assignee: 'me' });
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

	it('?mentions=1 swaps the list for the threads that mention me, on one page', async () => {
		vi.stubGlobal('useRoute', () => ({ query: { mentions: '1' } }));
		const { mentions, threads, hasMoreThreads } = useInbox();
		// Call order: list first page, list tail, counts, stats, mentions, unread mentions.
		const [first, , , , mentionList, unread] = created;
		expect(mentions.value).toBe(true);
		expect(first!.args()).toBe('skip');
		expect(mentionList!.args()).toEqual({ limit: 50 });
		expect(unread!.args()).toEqual({});

		mentionList!.data.value = { threads: [thread('m1'), thread('m2')], nextCursor: null };
		await nextTick();
		expect(ids(threads.value)).toEqual(['m1', 'm2']);
		expect(hasMoreThreads.value).toBe(false);

		mentions.value = false;
		expect(mentionList!.args()).toBe('skip');
		expect(first!.args()).toMatchObject({ filter: 'open' });
	});
});
