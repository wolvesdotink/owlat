import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import type { FunctionReference } from 'convex/server';
import {
	argsIdentity,
	createConvexSubscription,
	DEFAULT_SUBSCRIPTION_TIMEOUT,
	stableJson,
	toError,
} from '../convexSubscription';

const dev = vi.hoisted(() => ({ build: false }));
vi.mock('~/lib/runtimeLog', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isDevBuild: () => dev.build,
}));

const fakeQuery = 'api.test.list' as unknown as FunctionReference<'query'>;

type Args = Record<string, unknown>;

/** A subscription whose transport is a spy, holding its value in `data`. */
function subscribeTo(
	args: Args | (() => Args | 'skip'),
	opts: { keepPreviousData?: boolean } = {}
) {
	const data = ref<string | undefined>(undefined);
	const unsubscribe = vi.fn();
	const onRelease = vi.fn();
	let deliver: (value: string) => void = () => {};
	let fail: (error: unknown) => void = () => {};
	const open = vi.fn(
		(_args: Args, onUpdate: (v: string) => void, onError: (e: unknown) => void) => {
			deliver = onUpdate;
			fail = onError;
			return unsubscribe;
		}
	);
	const subscription = createConvexSubscription<Args, string>({
		query: fakeQuery,
		name: 'useTestQuery',
		args,
		open,
		hasData: () => data.value !== undefined,
		accept: (value) => {
			data.value = value;
		},
		clear: () => {
			data.value = undefined;
		},
		onRelease,
		...opts,
	});
	return {
		...subscription,
		data,
		open,
		unsubscribe,
		onRelease,
		deliver: (value: string) => deliver(value),
		fail: (error: unknown) => fail(error),
	};
}

let scope: ReturnType<typeof effectScope>;

beforeEach(() => {
	dev.build = false;
	scope = effectScope();
});

afterEach(() => {
	scope.stop();
	vi.restoreAllMocks();
});

describe('argsIdentity', () => {
	it('matches structurally identical args regardless of key order and undefined fields', () => {
		expect(argsIdentity({ a: 1, b: ['x'] })).toBe(argsIdentity({ b: ['x'], a: 1, c: undefined }));
		expect(argsIdentity({ a: 1 })).not.toBe(argsIdentity({ a: 2 }));
		expect(argsIdentity('skip')).toBe('skip');
	});

	it('reads through a reactive proxy', () => {
		expect(argsIdentity({ tags: reactive(['a', 'b']) })).toBe(argsIdentity({ tags: ['a', 'b'] }));
	});

	it('answers a fresh token for args that will not serialise', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic['self'] = cyclic;
		expect(argsIdentity(cyclic)).not.toBe(argsIdentity(cyclic));
	});
});

describe('stableJson', () => {
	it('sorts keys and drops undefined fields', () => {
		expect(stableJson({ b: 1, a: [null, 'x'], c: undefined })).toBe('{"a":[null,"x"],"b":1}');
		expect(stableJson(undefined)).toBe('undefined');
	});
});

describe('toError', () => {
	it('passes an Error through and wraps anything else', () => {
		const error = new Error('boom');
		expect(toError(error)).toBe(error);
		expect(toError('plain')).toEqual(new Error('plain'));
	});
});

describe('createConvexSubscription', () => {
	it('opens once and stays open across a structurally identical re-evaluation', async () => {
		const tags = reactive(['inbox']);
		const nonce = ref(0);
		const sub = scope.run(() =>
			subscribeTo(() => {
				void nonce.value;
				return { tags, folder: 'all' };
			})
		)!;
		sub.deliver('first');

		nonce.value += 1;
		await nextTick();

		expect(sub.open).toHaveBeenCalledOnce();
		expect(sub.unsubscribe).not.toHaveBeenCalled();
		expect(sub.data.value).toBe('first');

		tags.push('archive');
		await nextTick();
		expect(sub.open).toHaveBeenCalledTimes(2);
		expect(sub.unsubscribe).toHaveBeenCalledOnce();
		expect(sub.onRelease).toHaveBeenCalledOnce();
	});

	it('holds a skipped query in the loading state until data arrives, then goes idle on skip', async () => {
		const ready = ref(false);
		const sub = scope.run(() => subscribeTo(() => (ready.value ? { id: 1 } : 'skip')))!;
		expect(sub.open).not.toHaveBeenCalled();
		expect(sub.isLoading.value).toBe(true);

		ready.value = true;
		await nextTick();
		sub.deliver('value');
		expect(sub.isLoading.value).toBe(false);

		ready.value = false;
		await nextTick();
		expect(sub.isLoading.value).toBe(false);
		expect(sub.onRelease).toHaveBeenCalledOnce();
		expect(sub.data.value).toBe('value');
	});

	it('keeps the previous value on screen for keepPreviousData and flags the refetch', async () => {
		const id = ref(1);
		const sub = scope.run(() => subscribeTo(() => ({ id: id.value }), { keepPreviousData: true }))!;
		sub.deliver('one');

		id.value = 2;
		await nextTick();
		expect(sub.data.value).toBe('one');
		expect(sub.isRefetching.value).toBe(true);
		expect(sub.isLoading.value).toBe(false);

		sub.deliver('two');
		expect(sub.isRefetching.value).toBe(false);
	});

	it('blanks the value on a new-args load without keepPreviousData', async () => {
		const id = ref(1);
		const sub = scope.run(() => subscribeTo(() => ({ id: id.value })))!;
		sub.deliver('one');

		id.value = 2;
		await nextTick();
		expect(sub.data.value).toBeUndefined();
		expect(sub.isLoading.value).toBe(true);
	});

	it('wraps a non-Error rejection into an Error', () => {
		const sub = scope.run(() => subscribeTo({ id: 1 }))!;
		sub.fail('ArgumentValidationError: bad args');
		expect(sub.error.value).toBeInstanceOf(Error);
		expect(sub.error.value!.message).toBe('ArgumentValidationError: bad args');
		expect(sub.isLoading.value).toBe(false);
	});

	it('releases a transiently failed subscription and reopens it in the background', () => {
		vi.useFakeTimers();
		try {
			const sub = scope.run(() => subscribeTo({ id: 1 }))!;
			sub.deliver('one');

			sub.fail(new Error('Function execution timed out'));
			expect(sub.error.value).toBeNull();
			expect(sub.unsubscribe).toHaveBeenCalledOnce();
			expect(sub.onRelease).toHaveBeenCalledOnce();

			vi.advanceTimersByTime(1_200);
			expect(sub.open).toHaveBeenCalledTimes(2);
			expect(sub.isRefetching.value).toBe(true);
			expect(sub.data.value).toBe('one');
		} finally {
			vi.useRealTimers();
		}
	});

	it('refetch reopens with the current args and keeps the value on screen', () => {
		const sub = scope.run(() => subscribeTo({ id: 1 }))!;
		sub.deliver('one');
		sub.refetch();
		expect(sub.open).toHaveBeenCalledTimes(2);
		expect(sub.isRefetching.value).toBe(true);
		expect(sub.data.value).toBe('one');
	});

	it('reports a timeout after the default window', () => {
		vi.useFakeTimers();
		try {
			const sub = scope.run(() => subscribeTo({ id: 1 }))!;
			vi.advanceTimersByTime(DEFAULT_SUBSCRIPTION_TIMEOUT - 1);
			expect(sub.error.value).toBeNull();
			vi.advanceTimersByTime(1);
			expect(sub.error.value!.message).toBe('Convex query subscription timed out');
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a missing client', () => {
		const sub = scope.run(() =>
			createConvexSubscription<Args, string>({
				query: fakeQuery,
				name: 'useTestQuery',
				args: { id: 1 },
				open: null,
				hasData: () => false,
				accept: vi.fn(),
				clear: vi.fn(),
			})
		)!;
		expect(sub.error.value!.message).toBe('Convex client not initialized');
		expect(sub.isLoading.value).toBe(false);
	});

	it('releases the subscription when its scope is disposed', () => {
		const sub = scope.run(() => subscribeTo({ id: 1 }))!;
		scope.stop();
		expect(sub.unsubscribe).toHaveBeenCalledOnce();
		expect(sub.onRelease).toHaveBeenCalledOnce();
	});

	it('warns in a dev build when created outside an effect scope', () => {
		dev.build = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		subscribeTo({ id: 1 });
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toContain('[useTestQuery]');
		expect(warn.mock.calls[0]![0]).toContain('outside an effect scope');
	});

	it('stays quiet outside a dev build, and inside a scope', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		subscribeTo({ id: 1 });
		dev.build = true;
		scope.run(() => subscribeTo({ id: 1 }));
		expect(warn).not.toHaveBeenCalled();
	});
});
