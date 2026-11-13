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

/** Documents a reader handed back, per table, from index and table queries. */
export type QueriedDocuments = Record<string, number>;

const COUNTED_LIST_TERMINALS = new Set(['collect', 'take']);
const COUNTED_SINGLE_TERMINALS = new Set(['first', 'unique']);

function countingQuery(query: object, table: string, counts: QueriedDocuments): object {
	const add = (n: number) => {
		counts[table] = (counts[table] ?? 0) + n;
	};
	return new Proxy(query, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			if (prop === Symbol.asyncIterator) {
				return async function* () {
					for await (const doc of value.call(target) as AsyncIterable<unknown>) {
						add(1);
						yield doc;
					}
				};
			}
			if (typeof prop !== 'string') return value.bind(target);
			if (COUNTED_LIST_TERMINALS.has(prop)) {
				return async (...args: unknown[]) => {
					const docs = (await value.apply(target, args)) as unknown[];
					add(docs.length);
					return docs;
				};
			}
			if (COUNTED_SINGLE_TERMINALS.has(prop)) {
				return async (...args: unknown[]) => {
					const doc: unknown = await value.apply(target, args);
					if (doc !== null) add(1);
					return doc;
				};
			}
			if (prop === 'paginate') {
				return async (...args: unknown[]) => {
					const result = (await value.apply(target, args)) as { page: unknown[] };
					add(result.page.length);
					return result;
				};
			}
			return (...args: unknown[]) => {
				const next: unknown = value.apply(target, args);
				return next !== null && typeof next === 'object' && 'collect' in next
					? countingQuery(next, table, counts)
					: next;
			};
		},
	});
}

/**
 * `countingDb(db, counts)` wraps a reader and adds, per table, every document a
 * query returns (`collect`, `take`, `first`, `unique`, `paginate`, async
 * iteration). Point reads by id (`get`) are not counted. A range with no
 * `.filter()` returns every document it reads, so this is the documents a
 * lookup visits.
 */
export function countingDb<Db extends AnyReader>(db: Db, counts: QueriedDocuments): Db {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (prop !== 'query' || typeof value !== 'function') {
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return (table: string) =>
				countingQuery((target.query as (t: string) => object)(table), table, counts);
		},
	});
}
