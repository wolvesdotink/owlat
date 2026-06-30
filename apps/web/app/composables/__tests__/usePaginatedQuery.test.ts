import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { usePaginatedQuery } from '../usePaginatedQuery';

const fakeQuery = 'api.test.list' as unknown as Parameters<typeof usePaginatedQuery>[0];

type PaginatedResult = { results?: unknown[]; status?: string; loadMore?: (numItems: number) => void };

let mockSuccessCallback: ((result: PaginatedResult) => void) | null = null;
let mockErrorCallback: ((error: Error) => void) | null = null;
let mockSubDispose: ReturnType<typeof vi.fn>;
let mockClient: { onPaginatedUpdate_experimental: ReturnType<typeof vi.fn> };
let capturedUnmountCallback: (() => void) | null = null;

beforeEach(() => {
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
			usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

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
				results: [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }],
				status: 'CanLoadMore',
				loadMore: vi.fn(),
			});

			expect(results.value).toEqual([{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
			expect(status.value).toBe('CanLoadMore');
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});

		it('defaults results to [] if result.results is undefined', () => {
			const { results } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			mockSuccessCallback!({ status: 'Exhausted' });

			expect(results.value).toEqual([]);
		});

		it('defaults status to Exhausted if result.status is undefined', () => {
			const { status } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			mockSuccessCallback!({ results: [] });

			expect(status.value).toBe('Exhausted');
		});
	});

	describe('status transitions', () => {
		it('transitions from LoadingFirstPage to CanLoadMore', () => {
			const { status } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			expect(status.value).toBe('LoadingFirstPage');

			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });
			expect(status.value).toBe('CanLoadMore');
		});

		it('transitions from CanLoadMore to Exhausted', () => {
			const { status } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			mockSuccessCallback!({ results: [{ id: '1' }], status: 'CanLoadMore' });
			expect(status.value).toBe('CanLoadMore');

			mockSuccessCallback!({ results: [{ id: '1' }, { id: '2' }], status: 'Exhausted' });
			expect(status.value).toBe('Exhausted');
		});
	});

	describe('loadMore', () => {
		it('calls _loadMore function with numItems when available', () => {
			const mockLoadMore = vi.fn();
			const { loadMore } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			mockSuccessCallback!({
				results: [{ id: '1' }],
				status: 'CanLoadMore',
				loadMore: mockLoadMore,
			});

			loadMore(10);
			expect(mockLoadMore).toHaveBeenCalledWith(10);
		});

		it('does nothing when _loadMore is null', () => {
			const { loadMore } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			// Before any success callback, _loadMore is null
			expect(() => loadMore(10)).not.toThrow();
		});
	});

	describe('skip pattern', () => {
		it('stays loading and does not call onPaginatedUpdate_experimental when args return skip', () => {
			const { isLoading } = usePaginatedQuery(
				fakeQuery,
				() => 'skip' as const,
				{ initialNumItems: 20 }
			);

			expect(isLoading.value).toBe(true);
			expect(mockClient.onPaginatedUpdate_experimental).not.toHaveBeenCalled();
		});

		it('subscribes when args change from skip to real args', async () => {
			const shouldSkip = ref(true);
			const { isLoading } = usePaginatedQuery(
				fakeQuery,
				() => shouldSkip.value ? 'skip' as const : { teamId: '123' },
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
	});

	describe('error handling', () => {
		it('sets error and isLoading=false when error callback fires', () => {
			const { error, isLoading } = usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			const testError = new Error('Something went wrong');
			mockErrorCallback!(testError);

			expect(error.value).toBe(testError);
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
		it('unsubscribes on unmount', () => {
			usePaginatedQuery(
				fakeQuery,
				{ teamId: '123' },
				{ initialNumItems: 20 }
			);

			expect(capturedUnmountCallback).toBeTruthy();
			capturedUnmountCallback!();
			expect(mockSubDispose).toHaveBeenCalled();
		});

		it('unsubscribes and resubscribes when args change', async () => {
			const teamId = ref('123');
			usePaginatedQuery(
				fakeQuery,
				() => ({ teamId: teamId.value }),
				{ initialNumItems: 20 }
			);

			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(1);

			teamId.value = '456';
			await nextTick();

			expect(mockSubDispose).toHaveBeenCalled();
			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenCalledTimes(2);
			expect(mockClient.onPaginatedUpdate_experimental).toHaveBeenLastCalledWith(
				fakeQuery,
				{ teamId: '456' },
				{ initialNumItems: 20 },
				expect.any(Function),
				expect.any(Function)
			);
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
});
