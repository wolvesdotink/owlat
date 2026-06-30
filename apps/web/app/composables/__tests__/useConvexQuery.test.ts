import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConvexQuery } from '../useConvexQuery';

describe('useConvexQuery', () => {
	let mockOnUpdateCallback: ((data: unknown) => void) | null = null;
	let mockOnErrorCallback: ((error: unknown) => void) | null = null;
	let mockUnsubscribe: ReturnType<typeof vi.fn>;
	let mockClient: { onUpdate: ReturnType<typeof vi.fn> };
	let onScopeDisposeCallback: (() => void) | null = null;

	const fakeQuery = 'api.test.list' as unknown as Parameters<typeof useConvexQuery>[0];

	beforeEach(() => {
		mockOnUpdateCallback = null;
		mockOnErrorCallback = null;
		onScopeDisposeCallback = null;
		mockUnsubscribe = vi.fn();
		mockClient = {
			onUpdate: vi.fn((_query: unknown, _args: unknown, callback: (data: unknown) => void, onError: (error: unknown) => void) => {
				mockOnUpdateCallback = callback;
				mockOnErrorCallback = onError;
				return mockUnsubscribe;
			}),
		};
		vi.stubGlobal('useConvex', () => mockClient);
		vi.stubGlobal('getCurrentScope', () => ({}));
		vi.stubGlobal('onScopeDispose', (cb: () => void) => {
			onScopeDisposeCallback = cb;
		});
	});

	describe('initial state', () => {
		it('starts with isLoading=true, data=undefined, error=null', () => {
			const { data, isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(isLoading.value).toBe(true);
			expect(data.value).toBeUndefined();
			expect(error.value).toBeNull();
		});
	});

	describe('subscription', () => {
		it('subscribes immediately with correct query and args', () => {
			const args = { teamId: '123' };
			useConvexQuery(fakeQuery, args);

			expect(mockClient.onUpdate).toHaveBeenCalledOnce();
			expect(mockClient.onUpdate).toHaveBeenCalledWith(fakeQuery, args, expect.any(Function), expect.any(Function));
		});

		it('updates data and sets isLoading=false when callback fires', () => {
			const { data, isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(isLoading.value).toBe(true);

			const responseData = [{ id: '1', name: 'Test' }];
			mockOnUpdateCallback!(responseData);

			expect(data.value).toEqual(responseData);
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});

		it('sets error and isLoading=false when onError fires', () => {
			const { error, isLoading, data } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(isLoading.value).toBe(true);

			mockOnErrorCallback!(new Error('Query failed'));

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('Query failed');
			expect(isLoading.value).toBe(false);
			expect(data.value).toBeUndefined();
		});

		it('wraps non-Error values in Error when onError fires', () => {
			const { error, isLoading } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnErrorCallback!('string error');

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('string error');
			expect(isLoading.value).toBe(false);
		});
	});

	describe('skip behavior', () => {
		it('stays loading and does not call onUpdate when args return skip', () => {
			const { isLoading } = useConvexQuery(fakeQuery, () => 'skip' as const);

			expect(mockClient.onUpdate).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(true);
		});

		it('goes idle (isLoading=false) when args transition from valid to skip after data loaded', async () => {
			const skip = ref(false);
			const { data, isLoading } = useConvexQuery(fakeQuery, () => (skip.value ? 'skip' : { teamId: '1' }));

			// Deliver data for the valid args.
			mockOnUpdateCallback!({ ok: true });
			expect(isLoading.value).toBe(false);
			expect(data.value).toEqual({ ok: true });

			// Transition to skip: no pending request, so isLoading must not be
			// pinned true. Previously-loaded data is retained.
			skip.value = true;
			await nextTick();
			expect(isLoading.value).toBe(false);
			expect(data.value).toEqual({ ok: true });
		});
	});

	describe('null client', () => {
		it('sets error and isLoading=false when client is null', () => {
			vi.stubGlobal('useConvex', () => null);

			const { error, isLoading } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('Convex client not initialized');
			expect(isLoading.value).toBe(false);
		});
	});

	describe('cleanup', () => {
		it('cleans up subscription on unmount', () => {
			useConvexQuery(fakeQuery, { teamId: '123' });

			expect(mockClient.onUpdate).toHaveBeenCalledOnce();
			expect(onScopeDisposeCallback).toBeTypeOf('function');

			onScopeDisposeCallback!();

			expect(mockUnsubscribe).toHaveBeenCalledOnce();
		});

		it('does not call unsubscribe on unmount if no subscription exists', () => {
			vi.stubGlobal('useConvex', () => null);

			useConvexQuery(fakeQuery, { teamId: '123' });

			expect(onScopeDisposeCallback).toBeTypeOf('function');

			onScopeDisposeCallback!();

			expect(mockUnsubscribe).not.toHaveBeenCalled();
		});
	});

	describe('args reactivity', () => {
		it('re-subscribes when args change via factory function', async () => {
			const teamId = ref('123');
			useConvexQuery(fakeQuery, () => ({ teamId: teamId.value }));

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);
			expect(mockClient.onUpdate).toHaveBeenCalledWith(fakeQuery, { teamId: '123' }, expect.any(Function), expect.any(Function));

			teamId.value = '456';
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
			expect(mockClient.onUpdate).toHaveBeenLastCalledWith(fakeQuery, { teamId: '456' }, expect.any(Function), expect.any(Function));
		});

		it('unsubscribes old subscription before subscribing new on args change', async () => {
			const teamId = ref('123');
			useConvexQuery(fakeQuery, () => ({ teamId: teamId.value }));

			expect(mockUnsubscribe).not.toHaveBeenCalled();

			teamId.value = '456';
			await nextTick();

			expect(mockUnsubscribe).toHaveBeenCalledOnce();
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
		});
	});

	describe('subscription timeout', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('times out after default 10s when no callback fires', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(isLoading.value).toBe(true);
			expect(error.value).toBeNull();

			vi.advanceTimersByTime(10_000);

			expect(isLoading.value).toBe(false);
			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('Convex query subscription timed out');
		});

		it('clears timeout when data arrives before timeout', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnUpdateCallback!([{ id: '1' }]);
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();

			vi.advanceTimersByTime(10_000);

			// Should still be fine — timeout was cleared
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});

		it('clears timeout when error arrives before timeout', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnErrorCallback!(new Error('Query failed'));
			expect(isLoading.value).toBe(false);

			vi.advanceTimersByTime(10_000);

			// Should keep the original error, not overwrite with timeout
			expect(error.value!.message).toBe('Query failed');
		});

		it('respects custom timeout option', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' }, { timeout: 5_000 });

			expect(isLoading.value).toBe(true);

			vi.advanceTimersByTime(4_999);
			expect(isLoading.value).toBe(true);

			vi.advanceTimersByTime(1);
			expect(isLoading.value).toBe(false);
			expect(error.value!.message).toBe('Convex query subscription timed out');
		});

		it('does not start timeout when args are skip', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, () => 'skip' as const);

			vi.advanceTimersByTime(10_000);

			expect(isLoading.value).toBe(true);
			expect(error.value).toBeNull();
		});

		it('self-heals when data arrives after timeout', () => {
			const { data, isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			vi.advanceTimersByTime(10_000);
			expect(error.value!.message).toBe('Convex query subscription timed out');

			// Convex reconnects and delivers data
			mockOnUpdateCallback!([{ id: '1' }]);

			expect(data.value).toEqual([{ id: '1' }]);
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});
	});
});
