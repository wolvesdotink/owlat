/**
 * The shared-subscription registry behind `createConvexSubscription`.
 *
 * Every `useConvexQuery` used to open its own `client.onUpdate`, and release
 * it the moment its scope went away. The Convex client dedupes the wire, but
 * drops the value with its last listener, and hands a second listener the
 * value it already holds only after a `setTimeout(0)`. So back navigation and
 * tab switches flashed a skeleton for data that had been on screen a moment
 * before, and a reader page ran the same settings query through five or more
 * listeners, each with its own loading state.
 *
 * Here, owners of the same query and args on the same client share one
 * transport subscription. When the last owner leaves, it stays open for
 * `SUBSCRIPTION_LINGER_MS`; whoever opens it again, while it is live or
 * lingering, gets its current value synchronously, inside `open`.
 */
import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * A transport's unsubscribe. The Convex client's also carries
 * `getCurrentValue`, the value it holds locally for the query right now.
 */
type TransportHandle = (() => void) & { getCurrentValue?: () => unknown };

/** Opens the transport and returns its unsubscribe. */
export type OpenSubscription<Args, Update> = (
	args: Args,
	onUpdate: (update: Update) => void,
	onError: (error: unknown) => void
) => TransportHandle;

/** How long a query stays subscribed after its last owner has left. */
export const SUBSCRIPTION_LINGER_MS = 45_000;

/** Most released queries kept warm at once. Past this, the oldest one closes. */
export const MAX_LINGERING_SUBSCRIPTIONS = 64;

/**
 * Queries whose value carries message bodies: a thread page holds up to ten
 * inline bodies, so one lingering copy can run to several hundred KB, and the
 * reader's read-ahead and j/k browsing release exactly these. They linger for
 * less time and fewer of them at once, so what is kept (and kept live on the
 * server) after the reader has moved on stays a few MB, not tens.
 */
const BODY_BEARING_QUERIES: ReadonlySet<string> = new Set([
	'mail/mailbox/messages:getMessage',
	'mail/mailbox/messages:getMessageInlineBody',
	'mail/mailbox/messages:listThreadMessages',
]);

/** How long a body-bearing query stays subscribed after its last owner left. */
export const BODY_SUBSCRIPTION_LINGER_MS = 15_000;

/** Most released body-bearing queries kept warm at once (within the overall cap). */
export const MAX_LINGERING_BODY_SUBSCRIPTIONS = 12;

/** How a released query lingers: `body` for the queries above, `default` for the rest. */
export type LingerClass = 'default' | 'body';

export function lingerClassOf(query: FunctionReference<'query'>): LingerClass {
	return BODY_BEARING_QUERIES.has(functionNameOf(query)) ? 'body' : 'default';
}

interface SharedListener {
	update: (value: unknown) => void;
	fail: (error: unknown) => void;
}

/**
 * One transport subscription and everyone reading it. An entry is reachable
 * through `sharedEntries` while `registered`; a detached one (it failed, a
 * refetch replaced it, the identity changed) still serves its current owners
 * and closes with the last of them instead of lingering.
 */
interface SharedEntry {
	key: string;
	listeners: Set<SharedListener>;
	handle: TransportHandle | null;
	/** The transport was released, possibly before `open` returned its handle. */
	closed: boolean;
	registered: boolean;
	hasValue: boolean;
	value: unknown;
	lingerTimer: ReturnType<typeof setTimeout> | null;
	lingerClass: LingerClass;
}

/**
 * The registry: one entry per client, transport, query and args value. Module
 * scope on purpose, so a page that unmounts and comes back (back navigation, a
 * tab switch) finds the query it left still subscribed and already loaded.
 */
const sharedEntries = new Map<string, SharedEntry>();
/** Released entries waiting out their linger, oldest first. */
const lingering = new Set<SharedEntry>();
/** The body-bearing subset of `lingering`, oldest first. */
const lingeringBodies = new Set<SharedEntry>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;

function sourceId(source: object): number {
	let id = sourceIds.get(source);
	if (id === undefined) {
		nextSourceId += 1;
		id = nextSourceId;
		sourceIds.set(source, id);
	}
	return id;
}

export function functionNameOf(query: FunctionReference<'query'>): string {
	try {
		return getFunctionName(query);
	} catch {
		return String(query);
	}
}

/** Registry key for one query and args value on one client and transport. */
export function sharedSubscriptionKey(
	share: { source: object; variant: string },
	query: FunctionReference<'query'>,
	argsIdentity: string
): string {
	return `${sourceId(share.source)}|${share.variant}|${functionNameOf(query)}|${argsIdentity}`;
}

function cancelLinger(entry: SharedEntry): void {
	if (entry.lingerTimer !== null) {
		clearTimeout(entry.lingerTimer);
		entry.lingerTimer = null;
	}
	lingering.delete(entry);
	lingeringBodies.delete(entry);
}

// Calls the handle at most once: the Convex client's unsubscribe throws on a
// second call.
function closeTransport(entry: SharedEntry): void {
	entry.closed = true;
	cancelLinger(entry);
	const handle = entry.handle;
	entry.handle = null;
	handle?.();
}

/** Takes an entry out of the registry; an entry nobody reads any more closes now. */
function detach(entry: SharedEntry): void {
	if (!entry.registered) return;
	entry.registered = false;
	sharedEntries.delete(entry.key);
	cancelLinger(entry);
	if (entry.listeners.size === 0) closeTransport(entry);
}

function startLinger(entry: SharedEntry): void {
	const isBody = entry.lingerClass === 'body';
	entry.lingerTimer = setTimeout(
		() => {
			entry.lingerTimer = null;
			detach(entry);
		},
		isBody ? BODY_SUBSCRIPTION_LINGER_MS : SUBSCRIPTION_LINGER_MS
	);
	lingering.add(entry);
	if (isBody) {
		lingeringBodies.add(entry);
		if (lingeringBodies.size > MAX_LINGERING_BODY_SUBSCRIPTIONS) {
			const oldest = lingeringBodies.values().next().value;
			if (oldest) detach(oldest);
		}
	}
	if (lingering.size > MAX_LINGERING_SUBSCRIPTIONS) {
		const oldest = lingering.values().next().value;
		if (oldest) detach(oldest);
	}
}

/** The transport's local value, falling back to the last one it delivered. */
function currentValue(entry: SharedEntry): unknown {
	try {
		const value = entry.handle?.getCurrentValue?.();
		if (value !== undefined) return value;
	} catch {
		// The query errored locally; the error callback is on its way.
	}
	return entry.value;
}

// One owner's callback throwing must not starve the others of the same value.
// The throw still surfaces, just outside the loop. Iterates a snapshot: an owner
// that joins during the loop was already served its value by `openShared`.
function fanOut(entry: SharedEntry, call: (listener: SharedListener) => void): void {
	for (const listener of Array.from(entry.listeners)) {
		if (!entry.listeners.has(listener)) continue;
		try {
			call(listener);
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}
}

/**
 * Joins the shared subscription for `key`, opening it if nobody holds it. A
 * live or lingering entry that already has a value hands it to the new owner
 * synchronously. `fresh` detaches the current entry first, so the query
 * re-executes once its remaining owners have let go of it. `lingerClass`
 * (see {@link lingerClassOf}) sets how the entry lingers once released.
 */
export function openShared<Args, Update>(
	key: string,
	args: Args,
	open: OpenSubscription<Args, Update>,
	listener: SharedListener,
	fresh: boolean,
	lingerClass: LingerClass = 'default'
): () => void {
	let entry = sharedEntries.get(key);
	if (entry && fresh) {
		detach(entry);
		entry = undefined;
	}

	if (entry) {
		cancelLinger(entry);
		entry.listeners.add(listener);
		if (entry.hasValue) listener.update(currentValue(entry));
	} else {
		const created: SharedEntry = {
			key,
			listeners: new Set([listener]),
			handle: null,
			closed: false,
			registered: true,
			hasValue: false,
			value: undefined,
			lingerTimer: null,
			lingerClass,
		};
		entry = created;
		sharedEntries.set(key, created);
		const handle = open(
			args,
			(value) => {
				created.hasValue = true;
				created.value = value;
				fanOut(created, (l) => l.update(value));
			},
			(error) => {
				// A failed query is never handed to a later owner: each owner decides
				// for itself whether to retry, and a retry must reach the server.
				created.hasValue = false;
				created.value = undefined;
				detach(created);
				fanOut(created, (l) => l.fail(error));
				if (created.listeners.size === 0) closeTransport(created);
			}
		);
		if (created.closed) handle();
		else created.handle = handle;
	}

	const owned = entry;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		owned.listeners.delete(listener);
		if (owned.listeners.size > 0 || owned.closed) return;
		if (owned.registered) startLinger(owned);
		else closeTransport(owned);
	};
}

/**
 * Drops every cached query: closes the lingering ones and detaches the live
 * ones, so their owners keep what they have but nobody new is served from them.
 * Called when the signed-in identity or active organization changes, so a
 * value read under one identity never renders under the next.
 */
export function resetSharedConvexSubscriptions(): void {
	// Deleting the entry being visited is safe while iterating a Map.
	for (const entry of sharedEntries.values()) detach(entry);
}
