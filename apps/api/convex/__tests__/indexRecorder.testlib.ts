/**
 * Records which index a read seeks and the range it seeks with, so a test can
 * pin "this lookup rides an index range" rather than only its result (a
 * `.filter()` over a wider index returns the same rows, just after reading
 * more of them).
 *
 * `recordingDb(db, log)` wraps a reader: every `query(table).withIndex(name,
 * range)` still runs against the real reader, and the range callback is also
 * replayed once against a stub builder that notes each `eq`/`gt`/`gte`/`lt`/
 * `lte` call. Range callbacks are pure, so the replay is harmless.
 */

export interface IndexSeek {
	table: string;
	index: string;
	range: Array<[op: string, field: string, value: unknown]>;
}

type AnyReader = { query: (table: never) => unknown };

function rangeStub(range: IndexSeek['range']): Record<string, unknown> {
	const stub: Record<string, unknown> = {};
	for (const op of ['eq', 'gt', 'gte', 'lt', 'lte']) {
		stub[op] = (field: string, value: unknown) => {
			range.push([op, field, value]);
			return stub;
		};
	}
	return stub;
}

export function recordingDb<Db extends AnyReader>(db: Db, log: IndexSeek[]): Db {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'query') {
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return (table: string) => {
				const initializer = (target.query as (t: string) => Record<string, unknown>)(table);
				return new Proxy(initializer, {
					get(inner, innerProp, innerReceiver) {
						const value: unknown = Reflect.get(inner, innerProp, innerReceiver);
						if (innerProp !== 'withIndex' || typeof value !== 'function') {
							return typeof value === 'function' ? value.bind(inner) : value;
						}
						return (index: string, rangeFn?: (q: unknown) => unknown) => {
							const seek: IndexSeek = { table, index, range: [] };
							if (rangeFn) rangeFn(rangeStub(seek.range));
							log.push(seek);
							return value.call(inner, index, rangeFn);
						};
					},
				});
			};
		},
	});
}

/**
 * What a function read and wrote, observed through its `ctx.db`.
 *
 * `onRead(source, rows)` sees every document a read handed back, BEFORE any
 * post-filter in the code under test: the rows of a `take`, `collect`,
 * `first`, `unique` or `paginate` page, under `table:index` (`by_creation_time`
 * when no index was named), each row of an async iteration (`for await`)
 * under the same source, and a `get`'s row under `get`. A Convex `.filter()`
 * runs inside the query, so the rows it drops are not seen; a range without
 * one hands back every document it visits. `onWrite(id)` sees the id of every
 * `insert`, `patch`, `replace` and `delete`. The real reader and writer run
 * every call, so results are unchanged.
 */
export interface DbObserver {
	onRead(source: string, rows: ReadonlyArray<{ _id: string }>): void;
	onWrite?(id: string): void;
}

function returnedRows(result: unknown): Array<{ _id: string }> {
	if (result === null || result === undefined) return [];
	if (Array.isArray(result)) return result as Array<{ _id: string }>;
	if (typeof result === 'object' && 'page' in result) {
		return (result as { page: Array<{ _id: string }> }).page;
	}
	return typeof result === 'object' && '_id' in result ? [result as { _id: string }] : [];
}

function observedQuery(query: object, table: string, source: string, observer: DbObserver): object {
	return new Proxy(query, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			if (prop === Symbol.asyncIterator) {
				// A Convex query's iterator is the query itself, and starting it a
				// second time throws, so step the iterator it returns instead of
				// handing that back to `for await`.
				return async function* () {
					const rows = value.call(target) as AsyncIterator<{ _id: string }>;
					try {
						for (;;) {
							const step = await rows.next();
							if (step.done) return;
							observer.onRead(source, [step.value]);
							yield step.value;
						}
					} finally {
						await rows.return?.();
					}
				};
			}
			return (...args: unknown[]) => {
				const next =
					prop === 'withIndex' || prop === 'withSearchIndex'
						? `${table}:${String(args[0])}`
						: source;
				const result: unknown = value.apply(target, args);
				if (result instanceof Promise) {
					return result.then((resolved: unknown) => {
						observer.onRead(next, returnedRows(resolved));
						return resolved;
					});
				}
				if (result !== null && typeof result === 'object') {
					return observedQuery(result, table, next, observer);
				}
				return result;
			};
		},
	});
}

const WRITES = new Set(['insert', 'patch', 'replace', 'delete']);

export function observingDb<Db extends AnyReader>(db: Db, observer: DbObserver): Db {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			const call = value as (...a: unknown[]) => unknown;
			if (prop === 'query') {
				return (table: string) =>
					observedQuery(
						call.call(target, table) as object,
						table,
						`${table}:by_creation_time`,
						observer
					);
			}
			if (prop === 'get') {
				return async (...args: unknown[]) => {
					const row: unknown = await call.apply(target, args);
					observer.onRead('get', returnedRows(row));
					return row;
				};
			}
			if (typeof prop === 'string' && WRITES.has(prop)) {
				return async (...args: unknown[]) => {
					const result: unknown = await call.apply(target, args);
					if (prop === 'insert') {
						observer.onWrite?.(result as string);
					} else {
						// `patch(id, value)` or the table-named `patch(table, id, value)`.
						const named = prop === 'delete' ? args.length === 2 : args.length === 3;
						observer.onWrite?.(String(named ? args[1] : args[0]));
					}
					return result;
				};
			}
			return call.bind(target);
		},
	});
}

/** Documents returned per `table:index` source, before any post-filter. */
export type SourceReads = Map<string, number>;

export function countingDb<Db extends AnyReader>(db: Db, reads: SourceReads): Db {
	return observingDb(db, {
		onRead(source, rows) {
			reads.set(source, (reads.get(source) ?? 0) + rows.length);
		},
	});
}

/** The document ids a function read and the ones it wrote. */
export interface DocumentDependencies {
	read: Set<string>;
	written: Set<string>;
}

export function dependencyDb<Db extends AnyReader>(db: Db, deps: DocumentDependencies): Db {
	return observingDb(db, {
		onRead(_source, rows) {
			for (const row of rows) deps.read.add(row._id);
		},
		onWrite(id) {
			deps.written.add(id);
		},
	});
}

/** Documents a reader handed back, per table, from index and table queries. */
export type QueriedDocuments = Record<string, number>;

/**
 * `tableCountingDb(db, counts)` adds, per table, every document a query hands
 * back (see `DbObserver`). Point reads by id (`get`) are not counted, so this
 * is the documents the code's lookups visit.
 */
export function tableCountingDb<Db extends AnyReader>(db: Db, counts: QueriedDocuments): Db {
	return observingDb(db, {
		onRead(source, rows) {
			if (source === 'get') return;
			const table = source.slice(0, source.indexOf(':'));
			counts[table] = (counts[table] ?? 0) + rows.length;
		},
	});
}
