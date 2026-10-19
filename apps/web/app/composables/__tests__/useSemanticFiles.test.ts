/**
 * The Files page reads compact cards (`files.cards.*`), not the legacy
 * whole-row `semanticFiles.list` / `search` that carry each file's embedding
 * vectors and extracted text. A source filter goes to its own endpoint
 * (`listBySource` / `searchBySource`), which narrows through an index before
 * paginating; the unfiltered reads keep theirs, and with them their cursors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { useSemanticFiles } from '../useSemanticFiles';
import { usePaginatedQuery } from '../usePaginatedQuery';

const LIST = getFunctionName(api.files.cards.list);
const LIST_BY_SOURCE = getFunctionName(api.files.cards.listBySource);
const SEARCH = getFunctionName(api.files.cards.search);
const SEARCH_BY_SOURCE = getFunctionName(api.files.cards.searchBySource);

let query: ReturnType<typeof ref<string>>;

beforeEach(() => {
	query = ref('');
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useDebouncedSearch', () => ({ query, debouncedQuery: query }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
});

describe('useSemanticFiles — which read is live', () => {
	/** Every paginated subscription: its function name and current args. */
	let opened: Array<{ name: string; args: () => unknown; loadMore: ReturnType<typeof vi.fn> }>;

	beforeEach(() => {
		opened = [];
		vi.stubGlobal('usePaginatedQuery', (fn: unknown, args: () => unknown) => {
			const loadMore = vi.fn();
			opened.push({ name: getFunctionName(fn as never), args, loadMore });
			return {
				results: ref([]),
				status: ref('CanLoadMore'),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
				loadMore,
			};
		});
	});

	const live = () =>
		opened
			.map((sub) => ({ name: sub.name, args: sub.args() }))
			.filter((sub) => sub.args !== 'skip');

	it('opens exactly one of the four card reads, by search and source filter', async () => {
		const scope = effectScope();
		const files = scope.run(() => useSemanticFiles())!;

		expect(opened.map((sub) => sub.name)).toEqual([LIST, LIST_BY_SOURCE, SEARCH, SEARCH_BY_SOURCE]);
		expect(live()).toEqual([{ name: LIST, args: {} }]);

		files.sourceFilter.value = 'email_attachment';
		await nextTick();
		expect(live()).toEqual([{ name: LIST_BY_SOURCE, args: { sourceType: 'email_attachment' } }]);

		query.value = 'invoice';
		await nextTick();
		expect(live()).toEqual([
			{ name: SEARCH_BY_SOURCE, args: { query: 'invoice', sourceType: 'email_attachment' } },
		]);

		files.sourceFilter.value = null;
		await nextTick();
		expect(live()).toEqual([{ name: SEARCH, args: { query: 'invoice' } }]);
		scope.stop();
	});

	it('loads no further page on its own when a filtered page comes back short', async () => {
		const scope = effectScope();
		const files = scope.run(() => useSemanticFiles())!;
		files.sourceFilter.value = 'upload';
		await nextTick();
		await nextTick();

		expect(files.status.value).toBe('CanLoadMore');
		expect(files.files.value).toEqual([]);
		for (const sub of opened) expect(sub.loadMore).not.toHaveBeenCalled();

		files.loadMore();
		expect(opened.find((sub) => sub.name === LIST_BY_SOURCE)!.loadMore).toHaveBeenCalledTimes(1);
		scope.stop();
	});
});

describe('useSemanticFiles — cursors stay with the query that issued them', () => {
	type Update = { results: unknown[]; status: string; loadMore: (n: number) => boolean };
	let subscriptions: Array<{ name: string; args: unknown; push: (update: Update) => void }>;

	beforeEach(() => {
		vi.useFakeTimers();
		subscriptions = [];
		const client = {
			onPaginatedUpdate_experimental: vi.fn(
				(fn: unknown, args: unknown, _opts: unknown, onUpdate: (u: Update) => void) => {
					subscriptions.push({ name: getFunctionName(fn as never), args, push: onUpdate });
					return vi.fn();
				}
			),
		};
		vi.stubGlobal('useConvex', () => client);
		vi.stubGlobal('usePaginatedQuery', usePaginatedQuery);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('resumes the warm unfiltered read with its loaded pages, and opens each filter on its own args', async () => {
		const scope = effectScope();
		const files = scope.run(() => useSemanticFiles())!;
		expect(subscriptions.map((s) => [s.name, s.args])).toEqual([[LIST, {}]]);

		const twoPages = [{ _id: 'f1' }, { _id: 'f2' }];
		subscriptions[0]!.push({ results: twoPages, status: 'CanLoadMore', loadMore: () => true });
		expect(files.files.value).toEqual(twoPages);

		files.sourceFilter.value = 'upload';
		await nextTick();
		expect(subscriptions.map((s) => [s.name, s.args])).toEqual([
			[LIST, {}],
			[LIST_BY_SOURCE, { sourceType: 'upload' }],
		]);

		// Back within the linger: the same subscription, its pages, no new first page.
		vi.advanceTimersByTime(5_000);
		files.sourceFilter.value = null;
		await nextTick();
		expect(subscriptions).toHaveLength(2);
		expect(files.files.value).toEqual(twoPages);
		expect(files.status.value).toBe('CanLoadMore');

		// Another source is another query: its own subscription and first page.
		files.sourceFilter.value = 'email_attachment';
		await nextTick();
		expect(subscriptions.map((s) => [s.name, s.args])).toEqual([
			[LIST, {}],
			[LIST_BY_SOURCE, { sourceType: 'upload' }],
			[LIST_BY_SOURCE, { sourceType: 'email_attachment' }],
		]);
		// No args carry a cursor: the client keeps each one inside its subscription.
		for (const s of subscriptions) expect(s.args).not.toHaveProperty('paginationOpts');
		scope.stop();
	});
});
