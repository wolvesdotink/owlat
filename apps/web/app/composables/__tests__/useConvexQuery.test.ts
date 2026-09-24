import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConvexError } from 'convex/values';
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
			onUpdate: vi.fn(
				(
					_query: unknown,
					_args: unknown,
					callback: (data: unknown) => void,
					onError: (error: unknown) => void
				) => {
					mockOnUpdateCallback = callback;
					mockOnErrorCallback = onError;
					return mockUnsubscribe;
				}
			),
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
			expect(mockClient.onUpdate).toHaveBeenCalledWith(
				fakeQuery,
				args,
				expect.any(Function),
				expect.any(Function)
			);
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

		it('sets error and isLoading=false when onError fires with a backend refusal', () => {
			const { error, isLoading, data } = useConvexQuery(fakeQuery, { teamId: '123' });

			expect(isLoading.value).toBe(true);

			mockOnErrorCallback!(new ConvexError('Query failed'));

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('Query failed');
			expect(isLoading.value).toBe(false);
			expect(data.value).toBeUndefined();
		});

		it('wraps non-Error values in Error when onError fires', () => {
			const { error, isLoading } = useConvexQuery(fakeQuery, { teamId: '123' });

			// A validation failure is final, so it surfaces without a retry.
			mockOnErrorCallback!('ArgumentValidationError: string error');

			expect(error.value).toBeInstanceOf(Error);
			expect(error.value!.message).toBe('ArgumentValidationError: string error');
			expect(isLoading.value).toBe(false);
		});
	});

	describe('skip behavior', () => {
		it('stays loading and does not call onUpdate when args return skip', () => {
			const { isLoading } = useConvexQuery(fakeQuery, () => 'skip' as const);

			expect(mockClient.onUpdate).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(true);
		});

		it('re-subscribes with fresh args after a valid → skip → valid sequence (stale-data regression)', async () => {
			// The real Convex client's unsubscribe THROWS when called twice
			// (removeSubscriber reads a deleted query token). Mirror that here: the
			// composable used to leave the dead unsubscribe handle set across the
			// skip transition, call it again on the next valid args, and the throw
			// aborted the re-subscribe — the UI then showed the PREVIOUS args' data
			// forever (e.g. the add-sender domain hint naming the old domain).
			mockClient.onUpdate = vi.fn(
				(_query: unknown, _args: unknown, callback: (data: unknown) => void) => {
					mockOnUpdateCallback = callback;
					let dead = false;
					return vi.fn(() => {
						if (dead) throw new TypeError('unsubscribed twice');
						dead = true;
					});
				}
			);

			const email = ref('hallo@wolves.ink');
			const { data } = useConvexQuery(fakeQuery, () =>
				email.value.includes('@') ? { email: email.value } : ('skip' as const)
			);
			mockOnUpdateCallback!({ domain: 'wolves.ink' });
			expect(data.value).toEqual({ domain: 'wolves.ink' });

			// Mid-edit the address is invalid → skip (previous data retained by design).
			email.value = 'hallo';
			await nextTick();
			expect(data.value).toEqual({ domain: 'wolves.ink' });

			// Valid again with different args → MUST create a fresh subscription…
			email.value = 'hallo@example.com';
			await nextTick();
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
			expect(mockClient.onUpdate).toHaveBeenLastCalledWith(
				fakeQuery,
				{ email: 'hallo@example.com' },
				expect.any(Function),
				expect.any(Function)
			);
			// …and clear the stale result while the new one loads.
			expect(data.value).toBeUndefined();

			mockOnUpdateCallback!({ domain: 'example.com' });
			expect(data.value).toEqual({ domain: 'example.com' });
		});

		it('goes idle (isLoading=false) when args transition from valid to skip after data loaded', async () => {
			const skip = ref(false);
			const { data, isLoading } = useConvexQuery(fakeQuery, () =>
				skip.value ? 'skip' : { teamId: '1' }
			);

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
			expect(mockClient.onUpdate).toHaveBeenCalledWith(
				fakeQuery,
				{ teamId: '123' },
				expect.any(Function),
				expect.any(Function)
			);

			teamId.value = '456';
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
			expect(mockClient.onUpdate).toHaveBeenLastCalledWith(
				fakeQuery,
				{ teamId: '456' },
				expect.any(Function),
				expect.any(Function)
			);
		});

		it('does not resubscribe when args are deeply equal but a new object', async () => {
			// A Convex push replaces a prop with a structurally identical object;
			// the factory then produces a fresh literal with the same values. That
			// must NOT tear down the subscription — doing so blanks `data` and
			// flashes a spinner on every unrelated push.
			const message = ref({ id: 'm1', labels: ['inbox'] });
			const { data } = useConvexQuery(fakeQuery, () => ({
				id: message.value.id,
				labels: message.value.labels,
			}));
			mockOnUpdateCallback!({ body: 'hi' });

			message.value = { id: 'm1', labels: ['inbox'] };
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribe).not.toHaveBeenCalled();
			expect(data.value).toEqual({ body: 'hi' });
		});

		it('does resubscribe when a nested value changes', async () => {
			const message = ref({ id: 'm1', labels: ['inbox'] });
			useConvexQuery(fakeQuery, () => ({
				id: message.value.id,
				labels: message.value.labels,
			}));

			message.value = { id: 'm1', labels: ['archive'] };
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
			expect(mockClient.onUpdate).toHaveBeenLastCalledWith(
				fakeQuery,
				{ id: 'm1', labels: ['archive'] },
				expect.any(Function),
				expect.any(Function)
			);
		});

		it('subscribes once across skip → args → same args', async () => {
			const ready = ref(false);
			const nonce = ref(0);
			useConvexQuery(fakeQuery, () => {
				// `nonce` only forces re-evaluation; it is not part of the args.
				void nonce.value;
				return ready.value ? { teamId: '123' } : ('skip' as const);
			});

			expect(mockClient.onUpdate).not.toHaveBeenCalled();

			ready.value = true;
			await nextTick();
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);

			nonce.value = 1;
			await nextTick();
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribe).not.toHaveBeenCalled();
		});

		it('ignores key order when comparing args', async () => {
			const flipped = ref(false);
			useConvexQuery(fakeQuery, () =>
				flipped.value ? { b: 2, a: 1 } : ({ a: 1, b: 2 } as Record<string, number>)
			);

			flipped.value = true;
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);
		});

		it('falls back to re-subscribing when the args will not serialise', async () => {
			// Not valid Convex args, so the client is about to reject them anyway —
			// but the comparison runs inside a watcher, where throwing would take
			// the caller down. Degrade to the old behaviour (re-subscribe on every
			// evaluation) instead.
			const tick = ref(0);
			useConvexQuery(fakeQuery, () => {
				const cyclic: Record<string, unknown> = { tick: tick.value };
				cyclic['self'] = cyclic;
				return cyclic;
			});

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(1);

			tick.value = 1;
			await nextTick();

			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
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

			mockOnErrorCallback!(new ConvexError('Query failed'));
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

	describe('transient failure recovery (#818)', () => {
		const TIMEOUT_ERROR =
			'[CONVEX Q(topics/topics:list)] [Request ID: 1] Server Error\nUncaught Error: Function execution timed out (maximum duration: 1s)';

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('keeps loading and resubscribes after a function timeout instead of surfacing it', () => {
			const { data, isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));

			// Not an error yet: the page keeps its loading state while it retries.
			expect(error.value).toBeNull();
			expect(isLoading.value).toBe(true);
			// The failed subscription is released straight away, so a query shared
			// with another component re-runs on the server when it comes back.
			expect(mockUnsubscribe).toHaveBeenCalledOnce();
			expect(mockClient.onUpdate).toHaveBeenCalledOnce();

			vi.advanceTimersByTime(1_200);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);

			mockOnUpdateCallback!([{ id: '1' }]);
			expect(data.value).toEqual([{ id: '1' }]);
			expect(isLoading.value).toBe(false);
			expect(error.value).toBeNull();
		});

		it('surfaces the error once the retry budget is spent, with growing delays', () => {
			const { isLoading, error } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
			vi.advanceTimersByTime(1_200);
			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
			// The second wait is longer than the first.
			vi.advanceTimersByTime(1_200);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(1_200);
			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
			vi.advanceTimersByTime(4_800);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(4);
			expect(error.value).toBeNull();

			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));

			expect(error.value!.message).toBe(TIMEOUT_ERROR);
			expect(isLoading.value).toBe(false);
			vi.advanceTimersByTime(60_000);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(4);
		});

		it('surfaces a backend refusal at once, without retrying', () => {
			const { error } = useConvexQuery(fakeQuery, { teamId: '123' });

			mockOnErrorCallback!(
				new ConvexError({ category: 'forbidden', message: 'You do not have access.' })
			);

			expect(error.value).not.toBeNull();
			vi.advanceTimersByTime(60_000);
			expect(mockClient.onUpdate).toHaveBeenCalledOnce();
		});

		it('restores the full budget after a successful result', () => {
			const { error } = useConvexQuery(fakeQuery, { teamId: '123' });

			for (let i = 0; i < 3; i++) {
				mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
				vi.advanceTimersByTime(4_800);
			}
			mockOnUpdateCallback!([{ id: '1' }]);

			// A later failure gets a fresh set of retries.
			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
			expect(error.value).toBeNull();
			vi.advanceTimersByTime(1_200);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(5);
		});

		it('keeps loaded data on screen while a later failure is retried', () => {
			const { data, isLoading, isRefetching, error } = useConvexQuery(fakeQuery, {
				teamId: '123',
			});
			mockOnUpdateCallback!([{ id: '1' }]);

			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));
			vi.advanceTimersByTime(1_200);

			expect(data.value).toEqual([{ id: '1' }]);
			expect(isLoading.value).toBe(false);
			expect(isRefetching.value).toBe(true);
			expect(error.value).toBeNull();
		});

		it('refetch after a surfaced error clears it and resubscribes with a fresh budget', () => {
			const { error, isLoading, refetch } = useConvexQuery(fakeQuery, { teamId: '123' });
			mockOnErrorCallback!(new ConvexError('boom'));
			expect(error.value).not.toBeNull();

			refetch();

			expect(error.value).toBeNull();
			expect(isLoading.value).toBe(true);
			expect(mockClient.onUpdate).toHaveBeenCalledTimes(2);
		});

		it('drops a pending retry when the scope is disposed', () => {
			useConvexQuery(fakeQuery, { teamId: '123' });
			mockOnErrorCallback!(new Error(TIMEOUT_ERROR));

			onScopeDisposeCallback!();
			vi.advanceTimersByTime(10_000);

			expect(mockClient.onUpdate).toHaveBeenCalledOnce();
		});
	});
});
