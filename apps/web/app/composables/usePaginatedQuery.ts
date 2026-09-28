import type {
	FunctionReference,
	FunctionArgs,
	FunctionReturnType,
	PaginationResult,
} from 'convex/server';
import type { PaginationStatus } from 'convex/browser';
import { createConvexSubscription } from '~/lib/convexSubscription';

export type PaginatedQueryArgs<Query extends FunctionReference<'query'>> = Omit<
	FunctionArgs<Query>,
	'paginationOpts'
>;
type PaginatedItem<Query extends FunctionReference<'query'>> =
	FunctionReturnType<Query> extends PaginationResult<infer T> ? T : never;

type ArgsFactory<Args> = () => Args | 'skip';

export interface PaginatedQueryOptions {
	initialNumItems: number;
	timeout?: number;
	/** Keep the current rows on screen while new args load, flagged `isRefetching`. */
	keepPreviousData?: boolean;
}

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
export function usePaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: PaginatedQueryArgs<Query> | ArgsFactory<PaginatedQueryArgs<Query>>,
	options: PaginatedQueryOptions
) {
	const client = useConvex();
	const results = ref<PaginatedItem<Query>[]>([]) as Ref<PaginatedItem<Query>[]>;
	const status = ref<PaginationStatus>('LoadingFirstPage');
	const _loadMore = ref<((numItems: number) => boolean) | null>(null);

	const { error, isLoading, isRefetching, refetch } = createConvexSubscription<
		PaginatedQueryArgs<Query>,
		PaginatedUpdateResult<PaginatedItem<Query>>
	>({
		query,
		name: 'usePaginatedQuery',
		args,
		open: client
			? (resolved, onUpdate, onError) =>
					client.onPaginatedUpdate_experimental(
						query,
						resolved as FunctionArgs<Query>,
						{ initialNumItems: options.initialNumItems },
						(result: unknown) => onUpdate(result as PaginatedUpdateResult<PaginatedItem<Query>>),
						onError
					)
			: null,
		hasData: () => results.value.length > 0,
		accept: (update) => {
			results.value = update.results ?? [];
			status.value = update.status ?? 'Exhausted';
			_loadMore.value = update.loadMore ?? null;
		},
		// A first load (or a reload with nothing on screen) starts from the first
		// page. A keepPreviousData refetch skips this, so the rows and `status`
		// stay put until the new first page lands.
		clear: () => {
			results.value = [];
			status.value = 'LoadingFirstPage';
		},
		// `_loadMore` belongs to the subscription just released (args change, skip,
		// refetch, a retry wait). Null it so "Load more" on the still-visible rows
		// is a no-op instead of a call into a dead closure; the fresh first page
		// repopulates it.
		onRelease: () => {
			_loadMore.value = null;
		},
		keepPreviousData: options.keepPreviousData,
		timeout: options.timeout,
	});

	return {
		results,
		status: readonly(status),
		isLoading: readonly(isLoading),
		isRefetching: readonly(isRefetching),
		error: readonly(error),
		/** Reopen the subscription, keeping the current rows on screen until the first page lands. */
		refetch,
		/**
		 * Load the next page. A no-op while there is none to load from: before the
		 * first page, during a refetch and after a transition to skip (see
		 * `onRelease` above).
		 */
		loadMore: (numItems: number) => {
			_loadMore.value?.(numItems);
		},
	};
}
