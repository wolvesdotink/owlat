import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isReactive, nextTick, watch } from 'vue';
import { ConvexError } from 'convex/values';
import { usePaginatedQuery } from '../usePaginatedQuery';
import { SUBSCRIPTION_LINGER_MS } from '~/lib/sharedConvexSubscriptions';

const dev = vi.hoisted(() => ({ build: false }));
vi.mock('~/lib/runtimeLog', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isDevBuild: () => dev.build,
}));

const fakeQuery = 'api.test.list' as unknown as Parameters<typeof usePaginatedQuery>[0];

type PaginatedResult = {
	results?: unknown[];
	status?: string;
	loadMore?: (numItems: number) => void;
};

let mockSuccessCallback: ((result: PaginatedResult) => void) | null = null;
let mockErrorCallback: ((error: Error) => void) | null = null;
let mockSubDispose: ReturnType<typeof vi.fn>;
let mockClient: { onPaginatedUpdate_experimental: ReturnType<typeof vi.fn> };
let capturedUnmountCallback: (() => void) | null = null;

beforeEach(() => {
	dev.build = false;
	mockSuccessCallback = null;
	mockErrorCallback = null;
	capturedUnmountCallback = null;
	mockSubDispose = vi.fn();
	mockClient = {
		onPaginatedUpdate_experimental: vi.fn((_query, _args, _options, onSuccess, onError) => {
			mockSuccessCallback = onSuccess;
			mockErrorCallback = onError;
			return mockSubDispose;
		}),
	};
	vi.stubGlobal('useConvex', () => mockClient);
	vi.stubGlobal('getCurrentScope', () => ({}));
	vi.stubGlobal('onScopeDispose', (cb: () => void) => {
		capturedUnmountCallback = cb;
	});
});

describe('usePaginatedQuery', () => {
	describe('initial state', () => {
		it('starts with results=[], status=LoadingFirstPage, isLoading=true, error=null', () => {
			const { results, status, isLoading, error } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			expect(results.value).toEqual([]);
			expect(status.value).toBe('LoadingFirstPage');
			expect(isLoading.value).toBe(true);
			expect(error.value).toBeNull();
		});

		it('calls onPaginatedUpdate_experimental with correct query, args, and initialNumItems', () => {
			usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledWith(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 },
				expect.any(Function),
				expect.any(Function)
			);
		});
	});

	describe('data updates', () => {
		it('updates results, status, and isLoading when success callback fires', () => {
			const { results, status, isLoading, error } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			mockSuccessCallback!({
				results: [
					{ id: '1', name: 'Alice' },
					{ id: '2', name: 'Bob' },
				],
				status: 'CanLoadMore',
				loadMore: vi.fn(),
			});

			expect(results.value).toEqual([
				{ id: '1', name: 'Alice' },
				{ id: '2', name: 'Bob' },
			]);
			expect(status.value).toBe('CanLoadMore');
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});

		it('defaults results to [] if result.results is undefined', () => {
			const { results } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			mockSuccessCallback!({ status: 'Exhausted' });

			expect(results.value).toEqual([]);
		});

		it('defaults status to Exhausted if result.status is undefined', () => {
			const { status } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			mockSuccessCallback!({ results: [] });

			expect(status.value).toBe('Exhausted');
		});
	});

	describe('structural sharing', () => {
		const doc = (id: string, name: string) => ({ _id: id, name, tags: ['a'] });

		it('keeps unchanged rows when a later page loads or one row changes', () => {
			const { results } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 2 });

			mockSuccessCallback!({
				results: [doc('1', 'Alice'), doc('2', 'Bob')],
				status: 'CanLoadMore',
			});
			const [alice, bob] = results.value as ReturnType<typeof doc>[];

			// A second page lands: fresh objects from Convex for the first page too.
			mockSuccessCallback!({
				results: [doc('1', 'Alice'), doc('2', 'Bob'), doc('3', 'Cara')],
				status: 'Exhausted',
			});
			expect(results.value[0]).toBe(alice);
			expect(results.value[1]).toBe(bob);

			mockSuccessCallback!({
				results: [doc('1', 'Alice'), doc('2', 'Robert'), doc('3', 'Cara')],
				status: 'Exhausted',
			});
			expect(results.value[0]).toBe(alice);
			expect(results.value[1]).not.toBe(bob);
			expect(results.value[1]).toEqual(doc('2', 'Robert'));
		});

		it('leaves results untouched, and effects idle, when an update changes nothing', async () => {
			const { results } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 2 });
			mockSuccessCallback!({ results: [doc('1', 'Alice')], status: 'Exhausted' });
			const before = results.value;
			const onChange = vi.fn();
			watch(results, onChange, { flush: 'sync' });

			mockSuccessCallback!({ results: [doc('1', 'Alice')], status: 'Exhausted' });
			await nextTick();

			expect(results.value).toBe(before);
			expect(onChange).not.toHaveBeenCalled();
		});

		it('holds rows shallowly, without reactive proxies', () => {
			const { results } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 2 });
			const delivered = [doc('1', 'Alice')];

			mockSuccessCallback!({ results: delivered, status: 'Exhausted' });

			expect(isReactive(results.value)).toBe(false);
			expect(results.value[0]).toBe(delivered[0]);
		});
	});

	describe('status transitions', () => {
		it('transitions from LoadingFirstPage to CanLoadMore', () => {
			const { status } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			expect(status.value).toBe('LoadingFirstPage');

			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });
			expect(status.value).toBe('CanLoadMore');
		});

		it('transitions from CanLoadMore to Exhausted', () => {
			const { status } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });
			expect(status.value).toBe('CanLoadMore');

			mockSuccessCallback!({ results: [{ id: '1' }, { id: '2' }], status: 'Exhausted' });
			expect(status.value).toBe('Exhausted');
		});
	});

	describe('loadMore', () => {
		it('calls _loadMore function with numItems when available', () => {
			const mockLoadMore = vi.fn();
			const { loadMore } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			mockSuccessCallback!({
				results: [{ id: '1' }],
				status: 'CanLoadMore',
				loadMore: mockLoadMore,
			});

			loadMore(10);
			expect(mockLoadMore).toHaveBeenCalledWith(10);
		});

		it('does nothing when _loadMore is null', () => {
			const { loadMore } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			// Before any success callback, _loadMore is null
			expect(() => loadMore(10)).not.toThrow();
		});
	});

	describe('skip pattern', () => {
		it('stays loading and does not call onPaginatedUpdate_experimental when args return skip', () => {
			const { isLoading } = usePaginatedQuery(fakeQuery, () => 'skip' as const, {
				initialNumItems: 20,
			});

			expect(isLoading.value).toBe(true);
			expect(mockClient.onPaginatedUpdate_experimental).not.toHaveBeenCalled();
		});

		it('subscribes when args change from skip to real args', async () => {
			const shouldSkip = ref(true);
			const { isLoading } = usePaginatedQuery(
				fakeQuery,
				() => (shouldSkip.value ? ('skip' as const) : { teamId: '123' }),
				{ initialNumItems: 20 }
			);

			expect(mockClient.onPaginatedUpdate_experimental).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(true);

			shouldSkip.value = false;
			await nextTick();

			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledWith(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 },
				expect.any(Function),
				expect.any(Function)
			);
		});

		it('nulls loadMore on a transition to skip so a click cannot invoke the disposed closure', async () => {
			const shouldSkip = ref(false);
			const { results, status, isLoading, loadMore } = usePaginatedQuery(
				fakeQuery,
				() => (shouldSkip.value ? ('skip' as const) : { teamId: '123' }),
				{ initialNumItems: 20 }
			);

			const staleLoadMore = vi.fn();
			mockSuccessCallback!({
				results: [{ id: '1' }],
				status: 'CanLoadMore',
				loadMore: staleLoadMore,
			});
			expect(results.value).toEqual([{ id: '1' }]);
			expect(status.value).toBe('CanLoadMore');

			// Transition to skip (e.g. a workspace switch nulls the scoped id): the
			// subscription is disposed, rows stay on screen, isLoading goes false —
			// but loadMore must be a deterministic no-op, not a dead-closure call.
			shouldSkip.value = true;
			await nextTick();

			expect(isLoading.value).toBe(false);
			expect(results.value).toEqual([{ id: '1' }]);
			loadMore(10);
			expect(staleLoadMore).not.toHaveBeenCalled();
		});

		it('reports no error while skipped, even after the previous args failed', async () => {
			const shouldSkip = ref(false);
			const { error } = usePaginatedQuery(
				fakeQuery,
				() => (shouldSkip.value ? ('skip' as const) : { teamId: '123' }),
				{ initialNumItems: 20 }
			);
			mockErrorCallback!(new ConvexError('Something went wrong'));
			expect(error.value).not.toBeNull();

			shouldSkip.value = true;
			await nextTick();
			expect(error.value).toBeNull();
		});
	});

	describe('error handling', () => {
		it('sets error and isLoading=false when error callback fires', () => {
			const { error, isLoading } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			const testError = new ConvexError('Something went wrong');
			mockErrorCallback!(testError);

			expect(error.value).toBe(testError);
			expect(isLoading.value).toBe(false);
		});

		it('wraps a non-Error rejection into an Error', () => {
			const { error, isLoading } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			// A permanent failure, so it surfaces instead of being retried.
			(mockErrorCallback as unknown as (e: unknown) => void)('ArgumentValidationError: bad');

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('ArgumentValidationError: bad');
			expect(isLoading.value).toBe(false);
		});

		it('sets error when client is null', () => {
			vi.stubGlobal('useConvex', () => null);

			const { error, isLoading } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('Convex client not initialized');
			expect(isLoading.value).toBe(false);
		});
	});

	describe('cleanup', () => {
		it('unsubscribes once the linger after unmount runs out', () => {
			vi.useFakeTimers();
			try {
				usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

				expect(capturedUnmountCallback).toBeTruthy();
				capturedUnmountCallback!();
				expect(mockSubDispose).not.toHaveBeenCalled();

				vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
				expect(mockSubDispose).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		});

		it('hands a remount the pages loaded so far, synchronously', () => {
			const loadMorePage = vi.fn();
			usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });
			mockSuccessCallback!({
				results: [{ id: '1' }, { id: '2' }, { id: '3' }],
				status: 'CanLoadMore',
				loadMore: loadMorePage,
			});
			capturedUnmountCallback!();

			const again = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledOnce();
			expect(again.results.value).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
			expect(again.status.value).toBe('CanLoadMore');
			expect(again.isLoading.value).toBe(false);
			again.loadMore(20);
			expect(loadMorePage).toHaveBeenCalledWith(20);
		});

		it('keys the shared subscription by page size', () => {
			usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });
			usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 50 });
			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);
		});

		it('warns in a dev build when created outside an effect scope', () => {
			dev.build = true;
			vi.stubGlobal('getCurrentScope', () => undefined);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

				expect(warn).toHaveBeenCalledOnce();
				expect(warn.mock.calls[0]![0]).toContain('[usePaginatedQuery]');
				expect(warn.mock.calls[0]![0]).toContain('outside an effect scope');
				expect(capturedUnmountCallback).toBeNull();
			} finally {
				warn.mockRestore();
			}
		});

		it('does not resubscribe or drop loaded pages on a structurally identical re-evaluation', async () => {
			// Factories return a fresh literal on every evaluation. A deep watch
			// re-subscribed on each one, which reset `results` to the first page
			// and threw away everything "Load more" had fetched.
			const tags = reactive(['image/']);
			const nonce = ref(0);
			const loadMorePage = vi.fn();
			const { results, status, isLoading, loadMore } = usePaginatedQuery(
				fakeQuery,
				() => {
					void nonce.value;
					return { tags, search: undefined };
				},
				{ initialNumItems: 20 }
			);
			mockSuccessCallback!({
				results: [{ id: '1' }, { id: '2' }],
				status: 'CanLoadMore',
				loadMore: loadMorePage,
			});

			nonce.value += 1;
			await nextTick();

			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(1);
			expect(mockSubDispose).not.toHaveBeenCalled();
			expect(results.value).toEqual([{ id: '1' }, { id: '2' }]);
			expect(status.value).toBe('CanLoadMore');
			expect(isLoading.value).toBe(false);
			loadMore(20);
			expect(loadMorePage).toHaveBeenCalledWith(20);

			// A real change to the array still re-subscribes.
			tags.push('video/');
			await nextTick();
			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);
		});

		it('releases the old args after their linger and resubscribes when args change', async () => {
			vi.useFakeTimers();
			try {
				const teamId = ref('123');
				usePaginatedQuery(fakeQuery, () => ({ teamId: teamId.value }), { initialNumItems: 20 });

				expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(1);

				teamId.value = '456';
				await nextTick();

				expect(mockSubDispose).not.toHaveBeenCalled();
				vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
				expect(mockSubDispose).toHaveBeenCalledOnce();
				expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);
				expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenLastCalledWith(
					fakeQuery,
					{ teamId: '456' },
					{ initialNumItems: 20 },
					expect.any(Function),
					expect.any(Function)
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it('resets state when resubscribing', async () => {
			const teamId = ref('123');
			const { results, status, isLoading } = usePaginatedQuery(
				fakeQuery,
				() => ({ teamId: teamId.value }),
				{ initialNumItems: 20 }
			);

			// Simulate data arriving for first subscription
			mockSuccessCallback!({
				results: [{ id: '1' }],
				status: 'CanLoadMore',
			});

			expect(results.value).toEqual([{ id: '1' }]);
			expect(status.value).toBe('CanLoadMore');
			expect(isLoading.value).toBe(false);

			// Change args to trigger resubscription
			teamId.value = '456';
			await nextTick();

			expect(results.value).toEqual([]);
			expect(status.value).toBe('LoadingFirstPage');
			expect(isLoading.value).toBe(true);
		});
	});

	describe('keepPreviousData (stale-while-revalidate)', () => {
		it('keeps rows and flags isRefetching on an args-change resubscribe, then replaces on the new first page', async () => {
			const teamId = ref('123');
			const firstLoadMore = vi.fn();
			const { results, status, isLoading, isRefetching, loadMore } = usePaginatedQuery(
				fakeQuery,
				() => ({ teamId: teamId.value }),
				{ initialNumItems: 20, keepPreviousData: true }
			);

			// First page arrives with rows.
			mockSuccessCallback!({
				results: [{ id: '1' }],
				status: 'CanLoadMore',
				loadMore: firstLoadMore,
			});
			expect(results.value).toEqual([{ id: '1' }]);
			expect(isLoading.value).toBe(false);

			// Args change (e.g. search/filter) — rows present + keepPreviousData.
			teamId.value = '456';
			await nextTick();

			// Rows retained, background refetch flagged, first-load loading stays false,
			// status/loadMore preserved.
			expect(results.value).toEqual([{ id: '1' }]);
			expect(isRefetching.value).toBe(true);
			expect(isLoading.value).toBe(false);
			expect(status.value).toBe('CanLoadMore');

			// loadMore is a no-op mid-refetch (the preserved closure belongs to the
			// disposed subscription).
			loadMore(10);
			expect(firstLoadMore).not.toHaveBeenCalled();

			// New first page lands — results replaced, refetch cleared.
			const secondLoadMore = vi.fn();
			mockSuccessCallback!({
				results: [{ id: '2' }],
				status: 'CanLoadMore',
				loadMore: secondLoadMore,
			});
			expect(results.value).toEqual([{ id: '2' }]);
			expect(isRefetching.value).toBe(false);
			expect(isLoading.value).toBe(false);

			// loadMore works again against the fresh closure.
			loadMore(10);
			expect(secondLoadMore).toHaveBeenCalledWith(10);
		});

		it('fully resets to LoadingFirstPage on an args-change resubscribe when no rows are present', async () => {
			const teamId = ref('123');
			const { results, status, isLoading, isRefetching } = usePaginatedQuery(
				fakeQuery,
				() => ({ teamId: teamId.value }),
				{ initialNumItems: 20, keepPreviousData: true }
			);

			// First subscription resolves empty.
			mockSuccessCallback!({ results: [], status: 'Exhausted' });
			expect(results.value).toEqual([]);
			expect(isLoading.value).toBe(false);

			// Args change with no rows to preserve → skeleton path stays reachable.
			teamId.value = '456';
			await nextTick();

			expect(results.value).toEqual([]);
			expect(status.value).toBe('LoadingFirstPage');
			expect(isLoading.value).toBe(true);
			expect(isRefetching.value).toBe(false);
		});

		it('clears isRefetching when the error callback fires during a refetch', async () => {
			const teamId = ref('123');
			const { isRefetching, error, isLoading } = usePaginatedQuery(
				fakeQuery,
				() => ({ teamId: teamId.value }),
				{ initialNumItems: 20, keepPreviousData: true }
			);

			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });

			teamId.value = '456';
			await nextTick();
			expect(isRefetching.value).toBe(true);

			const testError = new ConvexError('refetch failed');
			mockErrorCallback!(testError);

			expect(isRefetching.value).toBe(false);
			expect(error.value).toBe(testError);
			expect(isLoading.value).toBe(false);
		});

		it('clears isRefetching when the subscription times out during a refetch', async () => {
			vi.useFakeTimers();
			try {
				const teamId = ref('123');
				const { isRefetching, error } = usePaginatedQuery(
					fakeQuery,
					() => ({ teamId: teamId.value }),
					{ initialNumItems: 20, keepPreviousData: true, timeout: 5000 }
				);

				mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });

				teamId.value = '456';
				await nextTick();
				expect(isRefetching.value).toBe(true);

				vi.advanceTimersByTime(5000);

				expect(isRefetching.value).toBe(false);
				expect(error.value).toBeInstanceOf(Error);
				expect(error.value!.message).toBe('Convex query subscription timed out');
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('transient failure recovery (#818)', () => {
		const TIMEOUT_ERROR = 'Uncaught Error: Function execution timed out (maximum duration: 1s)';

		it('resubscribes after a function timeout instead of surfacing it', () => {
			vi.useFakeTimers();
			try {
				const { results, isLoading, error } = usePaginatedQuery(
					fakeQuery,
					{ teamId: '123' },
					{ initialNumItems: 20 }
				);

				mockErrorCallback!(new Error(TIMEOUT_ERROR));
				expect(error.value).toBeNull();
				expect(isLoading.value).toBe(true);
				expect(mockSubDispose).toHaveBeenCalledOnce();

				vi.advanceTimersByTime(1_200);
				expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);

				mockSuccessCallback!({ results: [{ id: '1' }], status: 'Exhausted' });
				expect(results.value).toEqual([{ id: '1' }]);
				expect(isLoading.value).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it('surfaces the error once the retry budget is spent', () => {
			vi.useFakeTimers();
			try {
				const { isLoading, error } = usePaginatedQuery(
					fakeQuery,
					{ teamId: '123' },
					{ initialNumItems: 20 }
				);

				for (let i = 0; i < 3; i++) {
					mockErrorCallback!(new Error(TIMEOUT_ERROR));
					vi.advanceTimersByTime(4_800);
				}
				expect(error.value).toBeNull();

				mockErrorCallback!(new Error(TIMEOUT_ERROR));
				expect(error.value!.message).toBe(TIMEOUT_ERROR);
				expect(isLoading.value).toBe(false);
				expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(4);
			} finally {
				vi.useRealTimers();
			}
		});

		it('surfaces a backend refusal at once, without retrying', () => {
			const { error } = usePaginatedQuery(fakeQuery, { teamId: '123' }, { initialNumItems: 20 });

			mockErrorCallback!(new ConvexError('forbidden'));

			expect(error.value).not.toBeNull();
			expect(mockSubDispose).not.toHaveBeenCalled();
		});
	});

	describe('refetch', () => {
		it('reopens the subscription and clears a surfaced error', () => {
			const { error, isLoading, refetch } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);
			mockErrorCallback!(new ConvexError('boom'));
			expect(error.value).not.toBeNull();

			refetch();

			expect(mockSubDispose).toHaveBeenCalledOnce();
			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);
			expect(error.value).toBeNull();
			expect(isLoading.value).toBe(true);
		});

		it('keeps the current rows on screen while the first page reloads', () => {
			const { results, isRefetching, refetch } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);
			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });

			refetch();

			expect(results.value).toEqual([{ id: '1' }]);
			expect(isRefetching.value).toBe(true);
		});
	});
});
