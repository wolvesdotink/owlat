import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import { convexToJson } from 'convex/values';
import type { Ref } from 'vue';

export type ArgsOrFactory<Args> = Args | (() => Args | 'skip');

function resolveArgs<Args>(args: ArgsOrFactory<Args>): Args | 'skip' {
	return typeof args === 'function' ? (args as () => Args | 'skip')() : args;
}

/** JSON with object keys in a fixed order, so equal args always stringify equal. */
function stableJson(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Identity of a set of query args, for deciding whether to re-subscribe.
 *
 * Args factories return a fresh object literal on every evaluation, so comparing
 * by reference (or watching `deep`, which skips the changed-check entirely) makes
 * any unrelated re-evaluation — a Convex push handing a component a structurally
 * identical prop, say — tear down and reopen the subscription, blanking `data`
 * and flashing a spinner. Compare the VALUE instead. Convex args are
 * JSON-compatible, so `convexToJson` normalises the exotic members (Int64,
 * bytes) and a key-sorted stringify makes the rest order-insensitive; anything
 * `convexToJson` rejects is not a valid query arg anyway, so fall back to the raw
 * value rather than throwing out of a watcher.
 */
function argsIdentity(args: unknown): string {
	if (args === 'skip') return 'skip';
	try {
		return stableJson(convexToJson(args as Parameters<typeof convexToJson>[0]));
	} catch {
		return stableJson(args);
	}
}

/** Return type of useConvexQuery, preserving the query result type */
export interface ConvexQueryResult<T> {
	data: Ref<T | undefined>;
	error: Ref<Error | null>;
	isLoading: Ref<boolean>;
	/** True while re-subscribing with `keepPreviousData` and prior data is still shown. */
	isRefetching: Ref<boolean>;
	/**
	 * Force a fresh read by re-subscribing with the current args, keeping the
	 * prior data visible in the background. Needed when the query's result derives
	 * from state Convex can't invalidate reactively (e.g. `delivery.status`, which
	 * reads deployment env — an env change won't self-invalidate the subscription).
	 */
	refetch: () => void;
}

/**
 * Composable for subscribing to a Convex query.
 * Automatically updates when the data changes.
 *
 * Return "skip" from the args factory function to skip the query subscription.
 * This is useful when required arguments are not yet available.
 */
const DEFAULT_TIMEOUT = 10_000;

export function useConvexQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	options?: { timeout?: number; keepPreviousData?: boolean }
): ConvexQueryResult<FunctionReturnType<Query>> {
	const client = useConvex();
	const data = ref<FunctionReturnType<Query> | undefined>(undefined) as Ref<
		FunctionReturnType<Query> | undefined
	>;
	const error = ref<Error | null>(null);
	const isLoading = ref(true);
	const isRefetching = ref(false);

	let unsubscribe: (() => void) | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;

	const clearSubscriptionTimeout = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const resolvedArgs = computed(() => resolveArgs(args));
	const argsKey = computed(() => argsIdentity(resolvedArgs.value));

	const subscribe = (opts?: { background?: boolean }) => {
		// Clean up previous subscription and timeout. MUST null the handle after
		// calling it: the Convex client's unsubscribe throws on a second call
		// (removeSubscriber reads a deleted query token). Leaving it set meant a
		// valid → skip → valid args sequence (e.g. typing through an invalid
		// email) called the dead unsubscribe again, the throw aborted this
		// re-subscribe, and the UI silently kept the PREVIOUS args' data forever.
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		clearSubscriptionTimeout();

		// Skip if args indicate we should skip. There is no pending request, so
		// only stay in the loading state if we never delivered data (initial
		// skip, waiting for real args); once data has loaded, a transition to
		// skip is idle — never leave isLoading=true with no in-flight request.
		if (resolvedArgs.value === 'skip') {
			isLoading.value = data.value === undefined;
			isRefetching.value = false;
			return;
		}

		if (!client) {
			error.value = new Error('Convex client not initialized');
			isLoading.value = false;
			return;
		}

		// Stale-while-revalidate: when keepPreviousData is set (or this is an
		// explicit background refetch) and we already have data (e.g. switching
		// folders), keep showing it and flag a background refetch instead of
		// blanking to a full-pane spinner.
		if ((options?.keepPreviousData || opts?.background) && data.value !== undefined) {
			isRefetching.value = true;
		} else {
			isLoading.value = true;
			data.value = undefined;
		}
		error.value = null;

		unsubscribe = client.onUpdate(
			query,
			resolvedArgs.value,
			(newData) => {
				clearSubscriptionTimeout();
				data.value = newData;
				isLoading.value = false;
				isRefetching.value = false;
				error.value = null;
			},
			(e) => {
				clearSubscriptionTimeout();
				error.value = e instanceof Error ? e : new Error(String(e));
				isLoading.value = false;
				isRefetching.value = false;
			}
		);

		// Start timeout — if neither callback fires, stop loading with an error
		timeoutId = setTimeout(() => {
			timeoutId = null;
			if (isLoading.value || isRefetching.value) {
				error.value = new Error('Convex query subscription timed out');
				isLoading.value = false;
				isRefetching.value = false;
			}
		}, timeoutMs);
	};

	// Re-subscribe only when the args' VALUE changes — see `argsIdentity`.
	watch(argsKey, () => subscribe(), { immediate: true });

	// Force a fresh read with the current args, keeping prior data visible.
	const refetch = () => subscribe({ background: true });

	// Clean up on unmount
	if (getCurrentScope()) {
		onScopeDispose(() => {
			clearSubscriptionTimeout();
			if (unsubscribe) {
				unsubscribe();
			}
		});
	}

	return { data, error, isLoading, isRefetching, refetch };
}
