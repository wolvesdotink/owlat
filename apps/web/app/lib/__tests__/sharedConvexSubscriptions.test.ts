import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, ref } from 'vue';
import { ConvexError } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { createConvexSubscription } from '../convexSubscription';
import {
	BODY_SUBSCRIPTION_LINGER_MS,
	MAX_LINGERING_BODY_SUBSCRIPTIONS,
	MAX_LINGERING_SUBSCRIPTIONS,
	lingerClassOf,
	resetSharedConvexSubscriptions,
	SUBSCRIPTION_LINGER_MS,
} from '../sharedConvexSubscriptions';

const query = 'api.test.list' as unknown as FunctionReference<'query'>;
/** A query whose value carries message bodies (a reader thread page). */
const bodyQuery =
	'mail/mailbox/messages:listThreadMessages' as unknown as FunctionReference<'query'>;

type Args = Record<string, unknown>;

interface WireSubscription {
	args: Args;
	/** Pushes a value the way the Convex client does: store it, then call back. */
	push: (value: unknown) => void;
	fail: (error: unknown) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
	current: unknown;
}

/**
 * Stands in for `ConvexClient.onUpdate`: every call is one wire subscription,
 * and its handle answers `getCurrentValue` from what was last pushed.
 */
function fakeClient() {
	const wire: WireSubscription[] = [];
	const onUpdate = vi.fn(
		(args: Args, update: (value: unknown) => void, fail: (error: unknown) => void) => {
			const sub: WireSubscription = {
				args,
				push: (value) => {
					sub.current = value;
					update(value);
				},
				fail,
				unsubscribe: vi.fn(),
				current: undefined,
			};
			wire.push(sub);
			return Object.assign(() => sub.unsubscribe(), { getCurrentValue: () => sub.current });
		}
	);
	return { wire, onUpdate };
}

type Client = ReturnType<typeof fakeClient>;

/** One component reading `args` through the shared registry, in its own scope. */
function own(
	client: Client,
	args: Args | (() => Args | 'skip'),
	opts: {
		accept?: (value: unknown) => void;
		keepPreviousData?: boolean;
		query?: FunctionReference<'query'>;
	} = {}
) {
	const scope = effectScope();
	const data = ref<unknown>(undefined);
	const subscription = scope.run(() =>
		createConvexSubscription<Args, unknown>({
			query: opts.query ?? query,
			name: 'useTestQuery',
			args,
			open: (resolved, update, fail) => client.onUpdate(resolved, update, fail),
			share: { source: client, variant: 'query' },
			hasData: () => data.value !== undefined,
			accept: (value) => {
				opts.accept?.(value);
				data.value = value;
			},
			clear: () => {
				data.value = undefined;
			},
			keepPreviousData: opts.keepPreviousData,
		})
	)!;
	return { ...subscription, data, leave: () => scope.stop() };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	resetSharedConvexSubscriptions();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('shared Convex subscriptions', () => {
	it('opens one wire subscription per query and args, whoever asks', () => {
		const client = fakeClient();
		const a = own(client, { id: 1 });
		const b = own(client, { id: 1 });
		const other = own(client, { id: 2 });

		expect(client.onUpdate).toHaveBeenCalledTimes(2);

		client.wire[0]!.push('one');
		expect(a.data.value).toBe('one');
		expect(b.data.value).toBe('one');
		expect(other.data.value).toBeUndefined();

		// One owner leaving keeps the subscription for the other.
		a.leave();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(client.wire[0]!.unsubscribe).not.toHaveBeenCalled();
		client.wire[0]!.push('one, again');
		expect(b.data.value).toBe('one, again');
	});

	it('never shares across clients', () => {
		const first = fakeClient();
		const second = fakeClient();
		own(first, { id: 1 });
		own(second, { id: 1 });
		expect(first.onUpdate).toHaveBeenCalledOnce();
		expect(second.onUpdate).toHaveBeenCalledOnce();
	});

	it('hands a new owner the loaded value synchronously', () => {
		const client = fakeClient();
		own(client, { id: 1 });
		client.wire[0]!.push('one');

		const late = own(client, { id: 1 });

		expect(client.onUpdate).toHaveBeenCalledOnce();
		expect(late.data.value).toBe('one');
		expect(late.isLoading.value).toBe(false);
		expect(late.error.value).toBeNull();
	});

	it("prefers the transport's current value to the last one it delivered", () => {
		const client = fakeClient();
		own(client, { id: 1 });
		client.wire[0]!.push('delivered');
		// An optimistic update lands in the client's local store.
		client.wire[0]!.current = 'optimistic';

		expect(own(client, { id: 1 }).data.value).toBe('optimistic');
	});

	it('does not time out an owner served from the cache', () => {
		const client = fakeClient();
		own(client, { id: 1 });
		client.wire[0]!.push('one');
		const late = own(client, { id: 1 });

		vi.advanceTimersByTime(60_000);
		expect(late.error.value).toBeNull();
	});

	it('keeps a released query warm for the linger, then closes it', () => {
		const client = fakeClient();
		const first = own(client, { id: 1 });
		client.wire[0]!.push('one');
		first.leave();

		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS - 1);
		expect(client.wire[0]!.unsubscribe).not.toHaveBeenCalled();

		// Back inside the linger: served at once, and the linger is cancelled.
		const back = own(client, { id: 1 });
		expect(back.data.value).toBe('one');
		expect(client.onUpdate).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(client.wire[0]!.unsubscribe).not.toHaveBeenCalled();

		back.leave();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();

		// After the linger a fresh owner starts from a loading state.
		const later = own(client, { id: 1 });
		expect(client.onUpdate).toHaveBeenCalledTimes(2);
		expect(later.isLoading.value).toBe(true);
		expect(later.data.value).toBeUndefined();
	});

	it('keeps a lingering query current while nobody reads it', () => {
		const client = fakeClient();
		const first = own(client, { id: 1 });
		client.wire[0]!.push('one');
		first.leave();
		client.wire[0]!.push('two');

		expect(own(client, { id: 1 }).data.value).toBe('two');
	});

	it('closes the oldest lingering query past the cap', () => {
		const client = fakeClient();
		for (let i = 0; i <= MAX_LINGERING_SUBSCRIPTIONS; i += 1) own(client, { id: i }).leave();

		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		expect(client.wire[1]!.unsubscribe).not.toHaveBeenCalled();
		expect(client.wire[MAX_LINGERING_SUBSCRIPTIONS]!.unsubscribe).not.toHaveBeenCalled();
	});

	it('classes the reader queries that carry bodies, and only them, as body-bearing', () => {
		expect(lingerClassOf(api.mail.mailbox.messages.listThreadMessages)).toBe('body');
		expect(lingerClassOf(api.mail.mailbox.messages.getMessageInlineBody)).toBe('body');
		expect(lingerClassOf(api.mail.mailbox.messages.getMessage)).toBe('body');
		expect(lingerClassOf(api.mail.mailbox.queries.listFolders)).toBe('default');
	});

	it('keeps a released body-bearing query warm for the shorter body linger', () => {
		const client = fakeClient();
		own(client, { id: 1 }, { query: bodyQuery }).leave();
		own(client, { id: 1 }).leave();

		vi.advanceTimersByTime(BODY_SUBSCRIPTION_LINGER_MS);
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		expect(client.wire[1]!.unsubscribe).not.toHaveBeenCalled();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS - BODY_SUBSCRIPTION_LINGER_MS);
		expect(client.wire[1]!.unsubscribe).toHaveBeenCalledOnce();
	});

	it('caps lingering body-bearing queries on their own, sparing the rest', () => {
		const client = fakeClient();
		const light = own(client, { id: 'light' });
		light.leave();
		for (let i = 0; i <= MAX_LINGERING_BODY_SUBSCRIPTIONS; i += 1) {
			own(client, { id: i }, { query: bodyQuery }).leave();
		}

		// The oldest body linger closed; the older plain one did not.
		expect(client.wire[0]!.unsubscribe).not.toHaveBeenCalled();
		expect(client.wire[1]!.unsubscribe).toHaveBeenCalledOnce();
		expect(client.wire[2]!.unsubscribe).not.toHaveBeenCalled();
	});

	it('forgets everything on an identity reset', () => {
		const client = fakeClient();
		const gone = own(client, { id: 1 });
		const live = own(client, { id: 2 });
		client.wire[0]!.push('old identity, lingering');
		client.wire[1]!.push('old identity, on screen');
		gone.leave();

		resetSharedConvexSubscriptions();

		// The lingering query closes now; the one on screen stays with its owner.
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		expect(client.wire[1]!.unsubscribe).not.toHaveBeenCalled();
		expect(live.data.value).toBe('old identity, on screen');

		// Nobody new is served from either.
		const fresh = own(client, { id: 2 });
		expect(client.onUpdate).toHaveBeenCalledTimes(3);
		expect(fresh.data.value).toBeUndefined();
		expect(fresh.isLoading.value).toBe(true);

		// The detached query closes with its last owner, without lingering.
		live.leave();
		expect(client.wire[1]!.unsubscribe).toHaveBeenCalledOnce();
	});

	it('surfaces a refusal to every owner and never serves the failed query again', () => {
		const client = fakeClient();
		const a = own(client, { id: 1 });
		const b = own(client, { id: 1 });
		const bystander = own(client, { id: 2 });
		client.wire[1]!.push('fine');

		client.wire[0]!.fail(new ConvexError('Forbidden'));

		expect(a.error.value!.message).toBe('Forbidden');
		expect(b.error.value!.message).toBe('Forbidden');
		expect(bystander.error.value).toBeNull();
		expect(bystander.data.value).toBe('fine');

		const late = own(client, { id: 1 });
		expect(client.onUpdate).toHaveBeenCalledTimes(3);
		expect(late.isLoading.value).toBe(true);
		expect(late.error.value).toBeNull();

		// The failed query closes with its owners, without lingering.
		a.leave();
		expect(client.wire[0]!.unsubscribe).not.toHaveBeenCalled();
		b.leave();
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
	});

	it('lets owners that failed together retry against a fresh subscription', () => {
		const client = fakeClient();
		const a = own(client, { id: 1 });
		const b = own(client, { id: 1 });
		client.wire[0]!.push('one');

		client.wire[0]!.fail(new Error('Function execution timed out'));

		// Both release before their backoff, so the query is gone from the wire.
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		expect(a.error.value).toBeNull();

		vi.advanceTimersByTime(1_200);
		expect(client.onUpdate).toHaveBeenCalledTimes(2);
		client.wire[1]!.push('recovered');
		expect(a.data.value).toBe('recovered');
		expect(b.data.value).toBe('recovered');
	});

	it('closes a query that fails while it lingers', () => {
		const client = fakeClient();
		own(client, { id: 1 }).leave();
		client.wire[0]!.fail(new ConvexError('Forbidden'));

		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
	});

	it('still delivers to every owner when one of them throws', () => {
		const microtasks: Array<() => void> = [];
		vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => {
			microtasks.push(task);
		});
		const client = fakeClient();
		own(
			client,
			{ id: 1 },
			{
				accept: () => {
					throw new Error('render failed');
				},
			}
		);
		const b = own(client, { id: 1 });

		client.wire[0]!.push('one');

		expect(b.data.value).toBe('one');
		expect(microtasks).toHaveLength(1);
		expect(microtasks[0]!).toThrow('render failed');
	});

	it('refetch skips the cache and re-runs the query', () => {
		const client = fakeClient();
		const a = own(client, { id: 1 });
		client.wire[0]!.push('stale');

		a.refetch();

		// Its only owner moved on, so the old subscription closes at once and the
		// server runs the query again for the new one.
		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
		expect(client.onUpdate).toHaveBeenCalledTimes(2);
		expect(a.data.value).toBe('stale');
		expect(a.isRefetching.value).toBe(true);

		client.wire[1]!.push('fresh');
		expect(a.data.value).toBe('fresh');
		expect(a.isRefetching.value).toBe(false);
	});

	it('does not share args that will not serialise', () => {
		const client = fakeClient();
		const cyclic: Args = {};
		cyclic['self'] = cyclic;
		own(client, cyclic).leave();

		expect(client.wire[0]!.unsubscribe).toHaveBeenCalledOnce();
	});
});
