import type { FunctionReference, FunctionArgs, FunctionReturnType, PaginationResult } from 'convex/server';
import type { PaginationStatus } from 'convex/browser';

type PaginatedQueryArgs<Query extends FunctionReference<'query'>> = Omit<FunctionArgs<Query>, 'paginationOpts'>;
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
 * Note: Results are typed as `unknown[]` because Convex's onPaginatedUpdate_experimental
 * has mismatched declared vs runtime types, preventing proper generic inference.
 */
const DEFAULT_TIMEOUT = 10_000;

export function usePaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: PaginatedQueryArgs<Query> | ArgsFactory<PaginatedQueryArgs<Query>>,
	options: { initialNumItems: number; timeout?: number }
) {
	const client = useConvex();
	const results = ref<PaginatedItem<Query>[]>([]) as Ref<PaginatedItem<Query>[]>;
	const status = ref<PaginationStatus>('LoadingFirstPage');
	const isLoading = ref(true);
	const error = ref<Error | null>(null);

	let unsubscribe: (() => void) | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const _loadMore = ref<((numItems: number) => boolean) | null>(null);

	const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT;

	const clearSubscriptionTimeout = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const resolvedArgs = computed(() => resolveArgs(args));

	const subscribe = () => {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		clearSubscriptionTimeout();

		if (resolvedArgs.value === 'skip') {
			isLoading.value = true;
			return;
		}

		if (!client) {
			error.value = new Error('Convex client not initialized');
			isLoading.value = false;
			return;
		}

		isLoading.value = true;
		error.value = null;
		results.value = [];
		status.value = 'LoadingFirstPage';
		_loadMore.value = null;

		const sub = client.onPaginatedUpdate_experimental(
			query,
			resolvedArgs.value as FunctionArgs<Query>,
			{ initialNumItems: options.initialNumItems },
			(result: unknown) => {
				clearSubscriptionTimeout();
				const typed = result as PaginatedUpdateResult<PaginatedItem<Query>>;
				results.value = typed.results ?? [];
				status.value = typed.status ?? 'Exhausted';
				_loadMore.value = typed.loadMore ?? null;
				isLoading.value = false;
				error.value = null;
			},
			(e: Error) => {
				clearSubscriptionTimeout();
				error.value = e;
				isLoading.value = false;
			}
		);

		unsubscribe = () => sub();

		// Start timeout — if neither callback fires, stop loading with an error
		timeoutId = setTimeout(() => {
			timeoutId = null;
			if (isLoading.value) {
				error.value = new Error('Convex query subscription timed out');
				isLoading.value = false;
			}
		}, timeoutMs);
	};

	watch(resolvedArgs, subscribe, { immediate: true, deep: true });

	// Clean up via onScopeDispose (like useConvexQuery) rather than onUnmounted,
	// so the subscription is also torn down for non-component callers and inside
	// a manually-created effectScope — not only for a mounted component.
	if (getCurrentScope()) {
		onScopeDispose(() => {
			clearSubscriptionTimeout();
			if (unsubscribe) {
				unsubscribe();
			}
		});
	}

	return {
		results,
		status: readonly(status),
		isLoading: readonly(isLoading),
		error: readonly(error),
		loadMore: (numItems: number) => {
			_loadMore.value?.(numItems);
		},
	};
}
