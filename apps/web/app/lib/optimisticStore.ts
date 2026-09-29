import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';

/**
 * Typed building blocks for Convex optimistic updaters.
 *
 * A mutation run through `useBackendOperation` (or `useOptimisticMutation`) can
 * carry an `optimisticUpdate`: a function over the client's local query store
 * that patches the cached results the moment the mutation is sent. Convex
 * drops the patch once the server's own result for the mutation has arrived
 * (or the mutation failed), so the server stays the only authority and a
 * failed write needs no hand-written rollback.
 *
 * The raw store only offers `getAllQueries` / `setQuery`, and every updater
 * repeats the same loop around them. These helpers keep that loop in one
 * place: skip results that are still loading, only write when something
 * actually changed (an unchanged reference is a no-op, so untouched views don't
 * repaint), and narrow to the argument sets a change applies to.
 */

/** Which cached results of a query an updater touches. */
export type ArgsFilter<Q extends FunctionReference<'query'>> = (args: FunctionArgs<Q>) => boolean;

/**
 * Rewrite every loaded result of `query` in the local store.
 *
 * `update` gets the current value and the args it was fetched with. Return the
 * SAME value (by reference) to leave that result alone. Results that are
 * still loading (`undefined`) are skipped: an optimistic update has nothing to
 * patch there, and writing a value would invent one.
 *
 * Returns how many cached results were rewritten.
 */
export function updateQueries<Q extends FunctionReference<'query'>>(
	store: OptimisticLocalStore,
	query: Q,
	update: (value: FunctionReturnType<Q>, args: FunctionArgs<Q>) => FunctionReturnType<Q>,
	where?: ArgsFilter<Q>
): number {
	let written = 0;
	for (const { args, value } of store.getAllQueries(query)) {
		if (value === undefined) continue;
		if (where && !where(args)) continue;
		const next = update(value, args);
		if (next === value) continue;
		store.setQuery(query, args, next);
		written += 1;
	}
	return written;
}

/** One page of a paginated query, as the store holds it. */
interface StoredPage<T> {
	page: T[];
}

type PageItem<Q extends FunctionReference<'query'>> =
	FunctionReturnType<Q> extends StoredPage<infer T> ? T : never;

/**
 * Rewrite the rows of every loaded page of a paginated query.
 *
 * The paginated client stores each page as its own query result, keyed by the
 * query's args plus `paginationOpts`, so this walks all of them. `update` gets
 * one page's rows and returns the new rows; the same array means "unchanged".
 * `where` sees the args WITHOUT `paginationOpts`, which is what a caller
 * matches on (mailbox, folder, filter).
 */
export function updatePaginatedQueries<Q extends FunctionReference<'query'>>(
	store: OptimisticLocalStore,
	query: Q,
	update: (rows: PageItem<Q>[], args: Omit<FunctionArgs<Q>, 'paginationOpts'>) => PageItem<Q>[],
	where?: (args: Omit<FunctionArgs<Q>, 'paginationOpts'>) => boolean
): number {
	return updateQueries(store, query, (value, args) => {
		const stored = value as unknown;
		if (!isStoredPage<PageItem<Q>>(stored)) return value;
		const { paginationOpts: _paginationOpts, ...inner } = args as FunctionArgs<Q> & {
			paginationOpts?: unknown;
		};
		const pageArgs = inner as Omit<FunctionArgs<Q>, 'paginationOpts'>;
		if (where && !where(pageArgs)) return value;
		const rows = update(stored.page, pageArgs);
		if (rows === stored.page) return value;
		return { ...stored, page: rows } as FunctionReturnType<Q>;
	});
}

function isStoredPage<T>(value: unknown): value is StoredPage<T> {
	return (
		typeof value === 'object' && value !== null && Array.isArray((value as StoredPage<T>).page)
	);
}

/**
 * An args filter that matches when every given key equals the cached args'
 * value, compared the way Convex compares args (by their JSON encoding), so
 * ids, numbers and nested objects all compare by value. Keys not named are
 * ignored: `matchArgs({ mailboxId })` hits every folder view of that mailbox.
 */
export function matchArgs<Args extends Record<string, unknown>>(
	expected: Partial<Args>
): (args: Args) => boolean {
	const entries = Object.entries(expected).map(([key, value]) => [key, encode(value)] as const);
	return (args) => entries.every(([key, value]) => encode(args[key]) === value);
}

function encode(value: unknown): string {
	return value === undefined ? 'undefined' : JSON.stringify(convexToJson(value as Value));
}

type RowIds = string | Iterable<string>;

function idSet(ids: RowIds): ReadonlySet<string> {
	return typeof ids === 'string' ? new Set([ids]) : new Set(ids);
}

/**
 * Patch the rows whose `_id` is in `ids`. A partial object is merged in; a
 * function returns the replacement row. Returns the SAME array when no row
 * matched or every patch was a no-op, so {@link updateQueries} skips the write.
 */
export function patchRows<T extends { _id: string }>(
	rows: T[],
	ids: RowIds,
	patch: Partial<T> | ((row: T) => T)
): T[] {
	const wanted = idSet(ids);
	let changed = false;
	const next = rows.map((row) => {
		if (!wanted.has(row._id)) return row;
		const patched = typeof patch === 'function' ? patch(row) : mergeIfChanged(row, patch);
		if (patched !== row) changed = true;
		return patched;
	});
	return changed ? next : rows;
}

function mergeIfChanged<T extends object>(row: T, patch: Partial<T>): T {
	for (const key of Object.keys(patch) as (keyof T)[]) {
		if (!Object.is(row[key], patch[key])) return { ...row, ...patch };
	}
	return row;
}

/**
 * Drop the rows whose `_id` is in `ids`. Returns the SAME array when none of
 * them was present.
 */
export function removeRows<T extends { _id: string }>(rows: T[], ids: RowIds): T[] {
	const wanted = idSet(ids);
	const next = rows.filter((row) => !wanted.has(row._id));
	return next.length === rows.length ? rows : next;
}
