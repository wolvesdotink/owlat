/**
 * The subscription lifecycle behind `useConvexQuery` and `usePaginatedQuery`.
 *
 * Both composables used to carry their own copy of this: retry, timeout, the
 * skip and keep-previous-data branches, scope cleanup. Fixes landed in one copy
 * and not the other. The composables are now thin adapters that say how to open
 * their transport (`client.onUpdate`, `client.onPaginatedUpdate_experimental`)
 * and where a delivered value goes. Everything else lives here.
 *
 * Owners of the same query and args share one transport subscription (the
 * registry in `~/lib/sharedConvexSubscriptions`), and a released query lingers briefly so a remount reads its
 * value in the same tick instead of flashing a skeleton.
 *
 * Uses the Vue auto-imports (`computed`, `watch`, `getCurrentScope`, ...) like
 * the composables it serves, so their specs can stub the effect scope.
 */
import type { FunctionReference } from 'convex/server';
import { convexToJson } from 'convex/values';
import { isDevBuild, logWarn } from '~/lib/runtimeLog';
import { createTransientRetry } from '~/lib/queryRetry';
import {
	functionNameOf,
	lingerClassOf,
	openShared,
	sharedSubscriptionKey,
	type OpenSubscription,
	type ReleaseReason,
} from '~/lib/sharedConvexSubscriptions';
import type { Ref } from 'vue';

/** Query args, or a factory that returns them or `'skip'` when they are not ready yet. */
export type ArgsOrFactory<Args> = Args | (() => Args | 'skip');

/** How long a subscription may stay silent before it reports a timeout. */
export const DEFAULT_SUBSCRIPTION_TIMEOUT = 10_000;

/**
 * JSON with object keys in a fixed order. `convexToJson` already sorts keys and
 * drops `undefined` fields, so the sorting here is for the fallback path in
 * `argsIdentity`, where the args never went through it.
 */
export function stableJson(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Counter behind the last-resort identity below. Module scope so two queries
 * cannot collide on the same token.
 */
let unserialisableArgsCounter = 0;

/**
 * Identity of a set of query args, for deciding whether to re-subscribe.
 *
 * Args factories return a fresh object literal on every evaluation, so comparing
 * by reference (or watching `deep`, which skips the changed-check entirely) makes
 * any unrelated re-evaluation (a Convex push handing a component a structurally
 * identical prop, say) tear down and reopen the subscription. A plain query then
 * blanks `data` and flashes a spinner; a paginated one also throws away every
 * page the user already loaded. Compare the VALUE instead: Convex args are
 * JSON-compatible, and `convexToJson` normalises the exotic members (Int64,
 * bytes) into that shape.
 *
 * Anything `convexToJson` rejects is not a valid query arg, so the Convex client
 * is about to throw on it anyway. But this runs inside a watcher, where a throw
 * would take the caller down instead. Try the raw value, and if even that will
 * not stringify (a bigint, a cycle), answer with a token that is unique per
 * evaluation: the query then re-subscribes on every change.
 */
export function argsIdentity(args: unknown): string {
	if (args === 'skip') return 'skip';
	try {
		return stableJson(convexToJson(args as Parameters<typeof convexToJson>[0]));
	} catch {
		try {
			return stableJson(args);
		} catch {
			return `unserialisable:${(unserialisableArgsCounter += 1)}`;
		}
	}
}

/**
 * Identity of the args with the window arg left out: two args values with the
 * same frame read the same list, only more or less of it.
 */
function frameIdentity(args: unknown, windowArg: string): string {
	if (args === 'skip' || args === null || typeof args !== 'object') return argsIdentity(args);
	const { [windowArg]: _window, ...frame } = args as Record<string, unknown>;
	return argsIdentity(frame);
}

/** Anything a transport rejects with, as an `Error`. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export interface ConvexSubscriptionOptions<Args, Update> {
	/** The subscribed query: part of the shared-subscription key, and named in the out-of-scope warning. */
	query: FunctionReference<'query'>;
	/** The composable, as the prefix of the out-of-scope warning. */
	name: string;
	args: ArgsOrFactory<Args>;
	/** Opens the transport; `null` when there is no Convex client. */
	open: OpenSubscription<Args, Update> | null;
	/**
	 * Share the transport subscription with every other owner of the same query
	 * and args on the same `source` (the Convex client), and keep it warm for
	 * `SUBSCRIPTION_LINGER_MS` after the last owner leaves. `variant` tells
	 * transports apart (plain vs paginated with its page size). Without it each
	 * owner opens and closes its own subscription.
	 */
	share?: { source: object; variant: string };
	/** Whether the adapter holds a value from an earlier delivery. */
	hasData: () => boolean;
	/** Stores a delivered value. */
	accept: (update: Update) => void;
	/** Blanks the adapter's value for a first load. */
	clear: () => void;
	/**
	 * Runs once the live subscription has been released: args change, skip,
	 * refetch, a retry wait, scope disposal. Whatever the adapter kept from that
	 * subscription (a paginated `loadMore`) now points at a dead closure.
	 */
	onRelease?: () => void;
	/**
	 * The arg that only sizes a window over one list: a growable `limit` that
	 * "Load more" raises. When the args change in this arg alone, the previous
	 * window is superseded rather than left: it closes as soon as no other owner
	 * holds it, instead of lingering live (and re-running on every change) next
	 * to the window that replaced it. Any other args change lingers as usual.
	 */
	windowArg?: string;
	/** Keep showing the previous value while new args load, flagged `isRefetching`. */
	keepPreviousData?: boolean;
	timeout?: number;
}

export interface ConvexSubscription {
	error: Ref<Error | null>;
	isLoading: Ref<boolean>;
	/** True while re-subscribing with a previous value still on screen. */
	isRefetching: Ref<boolean>;
	/**
	 * Re-subscribe with the current args, keeping the previous value visible.
	 * Skips the shared cache, so the query runs again once no one else holds it.
	 */
	refetch: () => void;
	/**
	 * Drop the value on screen, so the next delivery is a first load again.
	 * `keepPreviousData` bridges one args change to the next within a session; a
	 * surface that starts over (a search overlay reopening) calls this so it
	 * never opens on the last session's result. A skipped query stays blank
	 * until its args return; a live one re-subscribes and reads its value afresh
	 * (in the same tick while the shared subscription is still warm).
	 */
	reset: () => void;
}

/**
 * Subscribes to a Convex query for as long as the calling effect scope lives,
 * and re-subscribes whenever the VALUE of the args changes.
 *
 * A transient server failure is retried with backoff before it reaches `error`
 * (see `~/lib/queryRetry`); a subscription that stays silent for `timeout` ms
 * reports a timeout. Returning `'skip'` from the args factory holds the query
 * until its args are ready.
 */
export function createConvexSubscription<Args, Update>(
	options: ConvexSubscriptionOptions<Args, Update>
): ConvexSubscription {
	const error = ref<Error | null>(null);
	const isLoading = ref(true);
	const isRefetching = ref(false);

	const timeoutMs = options.timeout ?? DEFAULT_SUBSCRIPTION_TIMEOUT;
	const retry = createTransientRetry();
	let unsubscribe: ((reason?: ReleaseReason) => void) | null = null;
	/** Frame and full identity of the args the live subscription was opened with. */
	let subscribedFrame: string | null = null;
	let subscribedKey: string | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const resolvedArgs = computed<Args | 'skip'>(() =>
		typeof options.args === 'function' ? (options.args as () => Args | 'skip')() : options.args
	);
	const argsKey = computed(() => argsIdentity(resolvedArgs.value));

	// Args that will not serialise get a one-off identity; sharing them would
	// only park a subscription nobody can ever find again.
	const sharedKeyFor = (): string | null => {
		const share = options.share;
		const identity = argsKey.value;
		if (!share || identity.startsWith('unserialisable:')) return null;
		return sharedSubscriptionKey(share, options.query, identity);
	};

	const clearSubscriptionTimeout = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	// MUST null the handle after calling it: the Convex client's unsubscribe
	// throws on a second call (removeSubscriber reads a deleted query token).
	// Leaving it set meant a valid → skip → valid args sequence (typing through
	// an invalid email, say) called the dead unsubscribe again, the throw aborted
	// the re-subscribe, and the UI kept the PREVIOUS args' data forever.
	const releaseSubscription = (reason?: ReleaseReason) => {
		if (!unsubscribe) return;
		const release = unsubscribe;
		unsubscribe = null;
		subscribedFrame = null;
		subscribedKey = null;
		release(reason);
		options.onRelease?.();
	};

	// The live window is superseded when the next args differ from it only in
	// `windowArg`. Same args (a reset) or a different frame (another room, another
	// folder) is an ordinary leave, and the old query lingers.
	const releaseReasonFor = (args: Args | 'skip'): ReleaseReason => {
		const windowArg = options.windowArg;
		if (!windowArg || args === 'skip' || subscribedFrame === null) return 'leave';
		if (argsKey.value === subscribedKey) return 'leave';
		return frameIdentity(args, windowArg) === subscribedFrame ? 'superseded' : 'leave';
	};

	const subscribe = (opts?: { background?: boolean; isRetry?: boolean; fresh?: boolean }) => {
		// A retry spends the budget; anything else (new args, a manual refetch)
		// starts it over.
		retry.cancel();
		if (!opts?.isRetry) retry.reset();
		const args = resolvedArgs.value;
		releaseSubscription(releaseReasonFor(args));
		clearSubscriptionTimeout();

		// There is no pending request, so only stay in the loading state if
		// nothing was ever delivered (initial skip, waiting for real args). Once a
		// value has loaded, a transition to skip is idle: never leave
		// isLoading=true with no request in flight.
		if (args === 'skip') {
			isLoading.value = !options.hasData();
			isRefetching.value = false;
			return;
		}

		if (!options.open) {
			error.value = new Error('Convex client not initialized');
			isLoading.value = false;
			return;
		}

		// Stale-while-revalidate: with keepPreviousData (or an explicit background
		// refetch) and a value on screen (switching folders, a search change), keep
		// showing it and flag a background refetch instead of blanking to a
		// full-pane spinner.
		if ((options.keepPreviousData || opts?.background) && options.hasData()) {
			isRefetching.value = true;
		} else {
			isLoading.value = true;
			options.clear();
		}
		error.value = null;

		const onUpdate = (update: Update) => {
			clearSubscriptionTimeout();
			retry.reset();
			options.accept(update);
			isLoading.value = false;
			isRefetching.value = false;
			error.value = null;
		};
		const onError = (e: unknown) => {
			clearSubscriptionTimeout();
			// Release the failed subscription BEFORE waiting, not at the retry:
			// the Convex client shares one server query between identical
			// subscriptions and re-runs it only once its last subscriber has
			// gone. Components that failed together unsubscribe together, so
			// the first one back re-executes the query instead of inheriting
			// the cached failure.
			if (retry.schedule(e, () => subscribe({ background: true, isRetry: true }))) {
				releaseSubscription();
				return;
			}
			error.value = toError(e);
			isLoading.value = false;
			isRefetching.value = false;
		};

		// If neither callback fires, stop loading with an error. Armed before
		// opening: a shared query that is already loaded delivers during `open`.
		timeoutId = setTimeout(() => {
			timeoutId = null;
			if (isLoading.value || isRefetching.value) {
				error.value = new Error('Convex query subscription timed out');
				isLoading.value = false;
				isRefetching.value = false;
			}
		}, timeoutMs);

		const shareKey = sharedKeyFor();
		if (options.windowArg) {
			subscribedFrame = frameIdentity(args, options.windowArg);
			subscribedKey = argsKey.value;
		}
		if (shareKey === null) {
			// An unshared transport has nothing to linger: it closes either way.
			const close = options.open(args, onUpdate, onError);
			unsubscribe = () => close();
			return;
		}
		unsubscribe = openShared(
			shareKey,
			args,
			options.open,
			{ update: (v) => onUpdate(v as Update), fail: onError },
			opts?.fresh === true,
			lingerClassOf(options.query)
		);
	};

	// Re-subscribe only when the args' VALUE changes. See `argsIdentity`.
	watch(argsKey, () => subscribe(), { immediate: true });

	if (getCurrentScope()) {
		onScopeDispose(() => {
			clearSubscriptionTimeout();
			retry.cancel();
			releaseSubscription();
		});
	} else if (isDevBuild()) {
		// No scope means nothing will ever call the unsubscribe: the socket
		// subscription outlives whatever created it. The usual cause is a call
		// made after an `await` in route middleware, where Nuxt's `runWithContext`
		// scope is no longer active: one leaked subscription per navigation, on a
		// guard that runs on nearly every page. Shared state like this belongs in a
		// module singleton owned by a detached `effectScope`; see `useFeatureFlag`.
		logWarn(
			`[${options.name}] ${functionNameOf(options.query)} was created outside an effect scope — its subscription will never be released.`
		);
	}

	const reset = () => {
		options.clear();
		if (resolvedArgs.value !== 'skip') {
			subscribe();
			return;
		}
		// The same state as a query that has not had its args yet.
		isLoading.value = true;
		isRefetching.value = false;
	};

	return {
		error,
		isLoading,
		isRefetching,
		refetch: () => subscribe({ background: true, fresh: true }),
		reset,
	};
}
