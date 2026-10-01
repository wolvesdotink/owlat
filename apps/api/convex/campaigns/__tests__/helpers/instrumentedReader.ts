/**
 * An in-memory `ctx.db` reader that COUNTS what a query function reads.
 *
 * convex-test runs the real query engine but reports nothing about cost, and
 * the recipient-page resolver's contract is a cost contract ("one page's reads
 * do not grow with unrelated rows"). This reader implements the slice of the
 * Convex reader API that audience resolution uses — `get`, `query(table)`,
 * `withIndex(name, q => q.eq(...)...)`, `paginate`, `collect`, `first`,
 * `unique`, `take` and async iteration — over plain arrays, and counts:
 *
 *   - `queries`   — index ranges opened: every `get` and every terminal query
 *                   call (the unit Convex's "index ranges read" limit counts);
 *   - `documents` — documents returned to the caller;
 *   - `bytes`     — JSON length of those documents (a proxy for read bytes).
 *
 * `withIndex` only understands equality prefixes, which is all the resolver
 * uses; the index NAME is ignored and the eq'd fields select the rows, so a
 * fixture does not have to restate the schema's index list. Rows keep insertion
 * order, standing in for `_creationTime` order.
 */

type Row = { _id: string; _creationTime: number } & Record<string, unknown>;

export interface ReadCounters {
	queries: number;
	documents: number;
	bytes: number;
}

const UNDEFINED_KEY = '\u0000undefined';

function keyOf(values: readonly unknown[]): string {
	return values.map((v) => (v === undefined ? UNDEFINED_KEY : JSON.stringify(v))).join('|');
}

export interface InstrumentedReader {
	db: unknown;
	counters: ReadCounters;
	reset(): void;
	insert(table: string, fields: Record<string, unknown>): string;
}

export function createInstrumentedReader(
	seed: Record<string, Array<Record<string, unknown>>> = {}
): InstrumentedReader {
	const tables = new Map<string, Row[]>();
	const byId = new Map<string, Row>();
	const sizes = new WeakMap<Row, number>();
	// table → eq-field signature → key → rows (lazily built, dropped on insert).
	const indexCache = new Map<string, Map<string, Map<string, Row[]>>>();
	const counters: ReadCounters = { queries: 0, documents: 0, bytes: 0 };
	let clock = 0;

	function insert(table: string, fields: Record<string, unknown>): string {
		const rows = tables.get(table) ?? [];
		tables.set(table, rows);
		const _id = (fields['_id'] as string | undefined) ?? `${table}:${rows.length}`;
		const row = { ...fields, _id, _creationTime: ++clock } as Row;
		rows.push(row);
		byId.set(_id, row);
		indexCache.delete(table);
		return _id;
	}
	for (const [table, rows] of Object.entries(seed)) for (const r of rows) insert(table, r);

	function sizeOf(row: Row): number {
		let s = sizes.get(row);
		if (s === undefined) {
			s = JSON.stringify(row).length;
			sizes.set(row, s);
		}
		return s;
	}
	function charge(rows: readonly Row[]): void {
		counters.documents += rows.length;
		for (const r of rows) counters.bytes += sizeOf(r);
	}

	function range(table: string, fields: string[], values: unknown[]): Row[] {
		const all = tables.get(table) ?? [];
		if (fields.length === 0) return all;
		let perTable = indexCache.get(table);
		if (!perTable) indexCache.set(table, (perTable = new Map()));
		const sig = fields.join(',');
		let index = perTable.get(sig);
		if (!index) {
			index = new Map();
			for (const r of all) {
				const k = keyOf(fields.map((f) => r[f]));
				const bucket = index.get(k);
				if (bucket) bucket.push(r);
				else index.set(k, [r]);
			}
			perTable.set(sig, index);
		}
		return index.get(keyOf(values)) ?? [];
	}

	function queryOver(table: string, fields: string[] = [], values: unknown[] = []) {
		const rows = () => range(table, fields, values);
		return {
			withIndex(_name: string, build?: (q: unknown) => unknown) {
				const f: string[] = [];
				const v: unknown[] = [];
				const q = {
					eq(field: string, value: unknown) {
						f.push(field);
						v.push(value);
						return q;
					},
				};
				build?.(q);
				return queryOver(table, f, v);
			},
			async collect() {
				counters.queries++;
				const r = rows();
				charge(r);
				return r.slice();
			},
			async take(n: number) {
				counters.queries++;
				const r = rows().slice(0, n);
				charge(r);
				return r;
			},
			async first() {
				counters.queries++;
				const r = rows()[0] ?? null;
				if (r) charge([r]);
				return r;
			},
			async unique() {
				counters.queries++;
				const r = rows();
				if (r.length > 1) throw new Error(`unique() matched ${r.length} rows in ${table}`);
				if (r[0]) charge([r[0]]);
				return r[0] ?? null;
			},
			async paginate({ cursor, numItems }: { cursor: string | null; numItems: number }) {
				counters.queries++;
				const start = cursor === null ? 0 : Number(cursor);
				const all = rows();
				const page = all.slice(start, start + numItems);
				charge(page);
				const end = start + page.length;
				return { page, isDone: end >= all.length, continueCursor: String(end) };
			},
			async *[Symbol.asyncIterator]() {
				counters.queries++;
				for (const r of rows()) {
					charge([r]);
					yield r;
				}
			},
		};
	}

	const db = {
		async get(id: string) {
			counters.queries++;
			const r = byId.get(id) ?? null;
			if (r) charge([r]);
			return r;
		},
		query(table: string) {
			return queryOver(table);
		},
	};

	return {
		db,
		counters,
		reset() {
			counters.queries = 0;
			counters.documents = 0;
			counters.bytes = 0;
		},
		insert,
	};
}
