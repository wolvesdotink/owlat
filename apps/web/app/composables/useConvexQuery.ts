import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';

type ArgsOrFactory<Args> = Args | (() => Args | 'skip');

function resolveArgs<Args>(args: ArgsOrFactory<Args>): Args | 'skip' {
	return typeof args === 'function' ? (args as () => Args | 'skip')() : args;
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

	const subscribe = (opts?: { background?: boolean }) => {
		// Clean up previous subscription and timeout
		if (unsubscribe) {
			unsubscribe();
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

	// Watch for args changes
	watch(resolvedArgs, () => subscribe(), { immediate: true, deep: true });

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
