import type {
	FunctionReference,
	FunctionArgs,
	FunctionReturnType,
	PaginationResult,
} from 'convex/server';
import type { PaginationStatus } from 'convex/browser';
import { createTransientRetry } from '~/lib/queryRetry';

type PaginatedQueryArgs<Query extends FunctionReference<'query'>> = Omit<
	FunctionArgs<Query>,
	'paginationOpts'
>;
type PaginatedItem<Query extends FunctionReference<'query'>> =
	FunctionReturnType<Query> extends PaginationResult<infer T> ? T : never;

type ArgsFactory<Args> = () => Args | 'skip';

/**
 * Shape of the paginated update result from onPaginatedUpdate_experimental.
 * Note: Convex's declared callback type is PaginationResult (page/isDone/continueCursor)
 * but at runtime delivers PaginatedQueryResult (results/status/loadMore).
 */
interface PaginatedUpdateResult<T> {
	results: T[];
	status: PaginationStatus;
	loadMore: ((numItems: number) => boolean) | null;
}

function resolveArgs<Args>(args: Args | ArgsFactory<Args>): Args | 'skip' {
	return typeof args === 'function' ? (args as ArgsFactory<Args>)() : args;
}

/**
 * Composable for subscribing to a paginated Convex query.
 * Automatically concatenates pages and supports infinite scroll via loadMore.
 *
 * Return "skip" from the args factory function to skip the query subscription.
 *
 * Transient server failures are retried with backoff before they reach `error`,
 * as in `useConvexQuery`. `refetch` reopens the subscription on demand (the
 * handler behind a "Try again" control); it starts over from the first page.
 *
 * Note: Results are typed as `unknown[]` because Convex's onPaginatedUpdate_experimental
 * has mismatched declared vs runtime types, preventing proper generic inference.
 */
const DEFAULT_TIMEOUT = 10_000;

export function usePaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: PaginatedQueryArgs<Query> | ArgsFactory<PaginatedQueryArgs<Query>>,
	options: { initialNumItems: number; timeout?: number; keepPreviousData?: boolean }
) {
	const client = useConvex();
	const results = ref<PaginatedItem<Query>[]>([]) as Ref<PaginatedItem<Query>[]>;
	const status = ref<PaginationStatus>('LoadingFirstPage');
	const isLoading = ref(true);
	const isRefetching = ref(false);
	const error = ref<Error | null>(null);

	let unsubscribe: (() => void) | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const _loadMore = ref<((numItems: number) => boolean) | null>(null);

	const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT;
	const retry = createTransientRetry();

	const clearSubscriptionTimeout = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const resolvedArgs = computed(() => resolveArgs(args));

	const releaseSubscription = () => {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
	};

	const subscribe = (opts?: { background?: boolean; isRetry?: boolean }) => {
		// A retry spends the budget; anything else (new args, a manual refetch)
		// starts it over.
		retry.cancel();
		if (!opts?.isRetry) retry.reset();
		releaseSubscription();
		clearSubscriptionTimeout();

		if (resolvedArgs.value === 'skip') {
			// Only stay in the first-load state if we never delivered rows; once
			// data has arrived, a transition to skip is idle, not loading.
			isLoading.value = results.value.length === 0;
			isRefetching.value = false;
			// The subscription was disposed at the top of subscribe(), so any
			// retained `_loadMore` now points at a dead closure. Null it so a
			// "Load more" click on the (still-visible) rows is a deterministic
			// no-op via the `?.` wrapper; the fresh first page repopulates it on
			// un-skip.
			_loadMore.value = null;
			return;
		}

		if (!client) {
			error.value = new Error('Convex client not initialized');
			isLoading.value = false;
			return;
		}

		// Stale-while-revalidate: when keepPreviousData is set and we already have
		// rows (e.g. a search/filter change resubscribes), keep the current rows on
		// screen and flag a background refetch instead of blanking to the full-pane
		// skeleton. Preserve status/loadMore until the new first page lands.
		if ((options.keepPreviousData || opts?.background) && results.value.length > 0) {
			isRefetching.value = true;
		} else {
			isLoading.value = true;
			results.value = [];
			status.value = 'LoadingFirstPage';
			_loadMore.value = null;
		}
		error.value = null;

		const sub = client.onPaginatedUpdate_experimental(
			query,
			resolvedArgs.value as FunctionArgs<Query>,
			{ initialNumItems: options.initialNumItems },
			(result: unknown) => {
				clearSubscriptionTimeout();
				retry.reset();
				const typed = result as PaginatedUpdateResult<PaginatedItem<Query>>;
				results.value = typed.results ?? [];
				status.value = typed.status ?? 'Exhausted';
				_loadMore.value = typed.loadMore ?? null;
				isLoading.value = false;
				isRefetching.value = false;
				error.value = null;
			},
			(e: Error) => {
				clearSubscriptionTimeout();
				// Released before the wait for the same reason as in useConvexQuery:
				// a shared server query only re-runs once every subscriber has gone.
				if (retry.schedule(e, () => subscribe({ background: true, isRetry: true }))) {
					releaseSubscription();
					// Its loadMore belongs to the subscription just released.
					_loadMore.value = null;
					return;
				}
				error.value = e;
				isLoading.value = false;
				isRefetching.value = false;
			}
		);

		unsubscribe = () => sub();

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

	watch(resolvedArgs, () => subscribe(), { immediate: true, deep: true });

	// Clean up via onScopeDispose (like useConvexQuery) rather than onUnmounted,
	// so the subscription is also torn down for non-component callers and inside
	// a manually-created effectScope — not only for a mounted component.
	if (getCurrentScope()) {
		onScopeDispose(() => {
			clearSubscriptionTimeout();
			retry.cancel();
			releaseSubscription();
		});
	}

	return {
		results,
		status: readonly(status),
		isLoading: readonly(isLoading),
		isRefetching: readonly(isRefetching),
		error: readonly(error),
		/** Reopen the subscription, keeping the current rows on screen until the first page lands. */
		refetch: () => subscribe({ background: true }),
		loadMore: (numItems: number) => {
			// During a keepPreviousData refetch, `_loadMore` still points at the
			// closure of the subscription disposed at the top of subscribe(), so
			// invoking it is undefined behaviour. No-op until the fresh first page
			// repopulates `_loadMore`; the refetch resolves near-instantly.
			if (isRefetching.value) return;
			_loadMore.value?.(numItems);
		},
	};
}
