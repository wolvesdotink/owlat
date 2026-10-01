import { describe, it, expect } from 'vitest';
import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';
import {
	matchArgs,
	patchRows,
	removeRows,
	updatePaginatedQueries,
	updateQueries,
} from '../optimisticStore';

interface Row {
	_id: string;
	isRead: boolean;
	subject: string;
}

type ListQuery = FunctionReference<
	'query',
	'public',
	{ mailboxId: string; folderRole?: string },
	{ messages: Row[] } | null
>;
type PagedQuery = FunctionReference<
	'query',
	'public',
	{ mailboxId: string; paginationOpts: { numItems: number; cursor: string | null } },
	{ page: Row[]; isDone: boolean; continueCursor: string }
>;

const listMessages = 'mail/mailbox/queries:listMessages' as unknown as ListQuery;
const pagedMessages = 'mail/mailbox/queries:pagedMessages' as unknown as PagedQuery;

/**
 * A stand-in for the client's local query store: results keyed by query name
 * plus the JSON encoding of their args, the same identity Convex uses. Records
 * every `setQuery`, so a test can tell "wrote the same value" from "skipped".
 */
function fakeStore() {
	const results = new Map<string, { name: string; args: Record<string, Value>; value: unknown }>();
	const writes: { name: string; args: unknown; value: unknown }[] = [];
	const key = (name: string, args: Record<string, Value>) =>
		`${name}|${JSON.stringify(convexToJson(args))}`;
	const store = {
		getQuery(query: unknown, args: Record<string, Value> = {}) {
			return results.get(key(query as string, args))?.value;
		},
		getAllQueries(query: unknown) {
			return [...results.values()]
				.filter((r) => r.name === (query as string))
				.map(({ args, value }) => ({ args, value }));
		},
		setQuery(query: unknown, args: Record<string, Value>, value: unknown) {
			writes.push({ name: query as string, args, value });
			results.set(key(query as string, args), { name: query as string, args, value });
		},
	} as unknown as OptimisticLocalStore;
	return {
		store,
		writes,
		seed(query: unknown, args: Record<string, unknown>, value: unknown) {
			const a = args as Record<string, Value>;
			results.set(key(query as string, a), { name: query as string, args: a, value });
		},
		get(query: unknown, args: Record<string, unknown>) {
			return results.get(key(query as string, args as Record<string, Value>))?.value;
		},
	};
}

const row = (id: string, isRead = false): Row => ({ _id: id, isRead, subject: `s-${id}` });

describe('updateQueries', () => {
	it('rewrites every loaded result and hands the updater its args', () => {
		const fake = fakeStore();
		fake.seed(listMessages, { mailboxId: 'm1', folderRole: 'inbox' }, { messages: [row('a')] });
		fake.seed(listMessages, { mailboxId: 'm1', folderRole: 'archive' }, { messages: [row('b')] });
		const seen: unknown[] = [];

		const written = updateQueries(fake.store, listMessages, (value, args) => {
			seen.push(args.folderRole);
			if (!value) return value;
			return { messages: patchRows(value.messages, ['a', 'b'], { isRead: true }) };
		});

		expect(written).toBe(2);
		expect(seen.sort()).toEqual(['archive', 'inbox']);
		expect(fake.get(listMessages, { mailboxId: 'm1', folderRole: 'inbox' })).toEqual({
			messages: [row('a', true)],
		});
	});

	it('skips results that are still loading', () => {
		const fake = fakeStore();
		fake.seed(listMessages, { mailboxId: 'm1' }, undefined);
		let calls = 0;

		updateQueries(fake.store, listMessages, (value) => {
			calls += 1;
			return value;
		});

		expect(calls).toBe(0);
		expect(fake.writes).toEqual([]);
	});

	it('does not write a result the updater hands back unchanged', () => {
		const fake = fakeStore();
		fake.seed(listMessages, { mailboxId: 'm1' }, { messages: [row('a')] });

		expect(updateQueries(fake.store, listMessages, (v) => v)).toBe(0);
		expect(fake.writes).toEqual([]);
	});

	it('only touches results whose args pass the filter', () => {
		const fake = fakeStore();
		fake.seed(listMessages, { mailboxId: 'm1' }, { messages: [row('a')] });
		fake.seed(listMessages, { mailboxId: 'm2' }, { messages: [row('a')] });

		updateQueries(
			fake.store,
			listMessages,
			(v) => (v ? { messages: removeRows(v.messages, 'a') } : v),
			matchArgs({ mailboxId: 'm2' })
		);

		expect(fake.get(listMessages, { mailboxId: 'm1' })).toEqual({ messages: [row('a')] });
		expect(fake.get(listMessages, { mailboxId: 'm2' })).toEqual({ messages: [] });
	});

	it('passes a null result through to the updater', () => {
		const fake = fakeStore();
		fake.seed(listMessages, { mailboxId: 'm1' }, null);
		const seen: unknown[] = [];

		updateQueries(fake.store, listMessages, (v) => {
			seen.push(v);
			return v;
		});

		expect(seen).toEqual([null]);
	});
});

describe('updatePaginatedQueries', () => {
	const page = (rows: Row[], cursor: string) => ({
		page: rows,
		isDone: false,
		continueCursor: cursor,
	});

	it('rewrites every loaded page and keeps the page metadata', () => {
		const fake = fakeStore();
		const first = { mailboxId: 'm1', paginationOpts: { numItems: 2, cursor: null } };
		const second = { mailboxId: 'm1', paginationOpts: { numItems: 2, cursor: 'c1' } };
		fake.seed(pagedMessages, first, page([row('a'), row('b')], 'c1'));
		fake.seed(pagedMessages, second, page([row('c')], 'c2'));

		const written = updatePaginatedQueries(fake.store, pagedMessages, (rows) =>
			patchRows(rows, ['b', 'c'], { isRead: true })
		);

		expect(written).toBe(2);
		expect(fake.get(pagedMessages, first)).toEqual(page([row('a'), row('b', true)], 'c1'));
		expect(fake.get(pagedMessages, second)).toEqual(page([row('c', true)], 'c2'));
	});

	it('matches on the args without paginationOpts and skips untouched pages', () => {
		const fake = fakeStore();
		const m1 = { mailboxId: 'm1', paginationOpts: { numItems: 2, cursor: null } };
		const m2 = { mailboxId: 'm2', paginationOpts: { numItems: 2, cursor: null } };
		fake.seed(pagedMessages, m1, page([row('a')], 'c1'));
		fake.seed(pagedMessages, m2, page([row('a')], 'c1'));
		const seenArgs: unknown[] = [];

		updatePaginatedQueries(
			fake.store,
			pagedMessages,
			(rows, args) => {
				seenArgs.push(args);
				return removeRows(rows, 'a');
			},
			matchArgs({ mailboxId: 'm1' })
		);

		expect(seenArgs).toEqual([{ mailboxId: 'm1' }]);
		expect(fake.get(pagedMessages, m1)).toEqual(page([], 'c1'));
		expect(fake.writes).toHaveLength(1);
	});

	it('leaves a page alone when no row changes', () => {
		const fake = fakeStore();
		const args = { mailboxId: 'm1', paginationOpts: { numItems: 2, cursor: null } };
		fake.seed(pagedMessages, args, page([row('a')], 'c1'));

		const written = updatePaginatedQueries(fake.store, pagedMessages, (rows) =>
			removeRows(rows, 'missing')
		);

		expect(written).toBe(0);
		expect(fake.writes).toEqual([]);
	});
});

describe('matchArgs', () => {
	it('compares named keys by value and ignores the rest', () => {
		const match = matchArgs<{ mailboxId: string; opts?: { n: number }; folderRole?: string }>({
			mailboxId: 'm1',
			opts: { n: 1 },
		});
		expect(match({ mailboxId: 'm1', opts: { n: 1 }, folderRole: 'inbox' })).toBe(true);
		expect(match({ mailboxId: 'm1', opts: { n: 2 } })).toBe(false);
		expect(match({ mailboxId: 'm2', opts: { n: 1 } })).toBe(false);
	});

	it('treats an explicitly undefined key as "absent"', () => {
		const match = matchArgs<{ mailboxId: string; folderId?: string }>({ folderId: undefined });
		expect(match({ mailboxId: 'm1' })).toBe(true);
		expect(match({ mailboxId: 'm1', folderId: 'f1' })).toBe(false);
	});
});

describe('patchRows', () => {
	it('merges a partial into matching rows only', () => {
		const rows = [row('a'), row('b')];
		const next = patchRows(rows, 'b', { isRead: true });
		expect(next).toEqual([row('a'), row('b', true)]);
		expect(next[0]).toBe(rows[0]);
		expect(rows[1]!.isRead).toBe(false);
	});

	it('accepts a function that builds the replacement row', () => {
		const next = patchRows([row('a')], new Set(['a']), (r) => ({ ...r, subject: 'x' }));
		expect(next).toEqual([{ ...row('a'), subject: 'x' }]);
	});

	it('returns the same array when nothing matched or the patch was a no-op', () => {
		const rows = [row('a', true)];
		expect(patchRows(rows, 'zzz', { isRead: false })).toBe(rows);
		expect(patchRows(rows, 'a', { isRead: true })).toBe(rows);
		expect(patchRows(rows, 'a', (r) => r)).toBe(rows);
	});
});

describe('removeRows', () => {
	it('drops the given ids', () => {
		expect(removeRows([row('a'), row('b'), row('c')], ['a', 'c'])).toEqual([row('b')]);
	});

	it('returns the same array when none were present', () => {
		const rows = [row('a')];
		expect(removeRows(rows, ['x'])).toBe(rows);
	});
});
