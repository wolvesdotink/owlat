/**
 * Counts the documents a Convex query would examine, for tests that bound a
 * query's read cost.
 *
 * convex-test materialises every candidate row in JS, so it cannot report how
 * many documents the real query engine reads. This wrapper records the shape of
 * each query on one table (index name, the equality prefix passed to
 * `withIndex`, and an optional `.filter` of `eq(field, value)` terms) and
 * replays it against the table's rows with Convex's streaming semantics:
 *
 *   - the index range is every row whose indexed fields equal the prefix,
 *     walked in index order (ties broken by `_creationTime`);
 *   - without a post-filter, `.first()` reads one document (or none);
 *   - with a post-filter, `.first()` reads until the first row that passes,
 *     or the whole range when none does.
 *
 * The real query still runs through `ctx.db`, so results are unchanged.
 */
import type { GenericId } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import type { TableNames } from '../../_generated/dataModel';

type Row = Record<string, unknown> & { _id: GenericId<string>; _creationTime: number };
type Eq = readonly [field: string, value: unknown];

export interface ScanRecord {
	index: string;
	prefix: Eq[];
	postFilter: Eq[];
	examined: number;
}

/** Records `.withIndex(...)` equality terms. Range bounds are not modelled. */
function prefixRecorder(out: Eq[]): unknown {
	const builder = {
		eq(field: string, value: unknown) {
			out.push([field, value]);
			return builder;
		},
	};
	return builder;
}

/** Records `.filter(q => q.eq(q.field(f), v))` and `q.and(...)` of such terms. */
function filterRecorder(): unknown {
	return {
		field: (name: string) => ({ field: name }),
		eq: (a: { field: string }, value: unknown): Eq[] => [[a.field, value]],
		and: (...terms: Eq[][]): Eq[] => terms.flat(),
	};
}

const matches = (row: Row, terms: Eq[]) => terms.every(([f, v]) => row[f] === v);

/**
 * Wrap `ctx` so every `.first()` on `table` appends a {@link ScanRecord} to
 * `log`. Other tables and other terminal methods pass through untouched.
 */
export function recordScans(ctx: MutationCtx, table: TableNames, log: ScanRecord[]): MutationCtx {
	const db = new Proxy(ctx.db, {
		get(target, prop, receiver) {
			if (prop !== 'query') return Reflect.get(target, prop, receiver);
			return (name: TableNames) => {
				const real = target.query(name);
				if (name !== table) return real;
				const prefix: Eq[] = [];
				const postFilter: Eq[] = [];
				let index = 'by_creation_time';
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				let q: any = real;
				const wrapper = {
					withIndex(indexName: string, range?: (b: unknown) => unknown) {
						index = indexName;
						if (range) range(prefixRecorder(prefix));
						q = q.withIndex(indexName, range);
						return wrapper;
					},
					filter(fn: (b: unknown) => Eq[]) {
						postFilter.push(...fn(filterRecorder()));
						q = q.filter(fn);
						return wrapper;
					},
					async first() {
						const all = (await target.query(table).collect()) as unknown as Row[];
						const range = all
							.filter((row) => matches(row, prefix))
							.sort((a, b) => a._creationTime - b._creationTime);
						let examined: number;
						if (postFilter.length === 0) {
							examined = Math.min(1, range.length);
						} else {
							const hit = range.findIndex((row) => matches(row, postFilter));
							examined = hit === -1 ? range.length : hit + 1;
						}
						log.push({ index, prefix: [...prefix], postFilter: [...postFilter], examined });
						return q.first();
					},
				};
				return wrapper;
			};
		},
	});
	return { ...ctx, db } as MutationCtx;
}
