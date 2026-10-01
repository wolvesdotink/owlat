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
