/**
 * Source-filtered Files reads (`files.cards.listBySource` / `searchBySource`,
 * plan item OW-070).
 *
 * The existing `list` / `search` filter `sourceType` after paginating, so a
 * filtered page can come back empty while matches sit further down. The new
 * endpoints narrow through `by_source_and_created` / `search_files_by_source`
 * first. They are separate functions because a pagination cursor belongs to
 * the index that issued it: the old endpoints keep their index, and clients
 * already paging them keep working.
 *
 * convex-test cursors are bare index-key tuples, and its search ignores the
 * search-index definition and relevance, so it cannot show that the real
 * backend refuses a foreign cursor. The schema and query-construction pins
 * below are the in-repo evidence that no existing endpoint moved index; the
 * runtime check is the pre-release smoke on a disposable backend.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { PaginationOptions } from 'convex/server';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import * as readers from '../lib/semanticFileCards';
import { enableFeatures } from './factories';

const sessionMock = vi.hoisted(() => ({
	userId: 'boss',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getSingletonOrganizationId: vi.fn(async () => 'test-org'),
	};
});

// Every page reader still runs; the wrappers only record which one an
// endpoint called.
vi.mock('../lib/semanticFileCards', async () => {
	const actual = await vi.importActual<typeof readers>('../lib/semanticFileCards');
	return {
		...actual,
		listFilesPage: vi.fn(actual.listFilesPage),
		searchFilesPage: vi.fn(actual.searchFilesPage),
		listFilesBySourcePage: vi.fn(actual.listFilesBySourcePage),
		searchFilesBySourcePage: vi.fn(actual.searchFilesBySourcePage),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;
type Source = Doc<'semanticFiles'>['sourceType'];
type Page = {
	page: Array<{ _id: string; sourceType: Source }>;
	isDone: boolean;
	continueCursor: string;
};

beforeEach(() => {
	sessionMock.userId = 'boss';
	sessionMock.role = 'owner';
	vi.clearAllMocks();
});

async function insertFile(
	t: Harness,
	sourceType: Source,
	createdAt: number,
	extra: Partial<Doc<'semanticFiles'>> = {}
): Promise<Id<'semanticFiles'>> {
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename: `${sourceType}-${createdAt}.txt`,
			mimeType: 'text/plain',
			fileSize: 10,
			sourceType,
			version: 1,
			embedding: [],
			searchableText: `quarterly report ${sourceType} ${createdAt}`,
			createdAt,
			updatedAt: createdAt,
			...extra,
		})
	);
}

/** Walk an endpoint to the end; returns the ids in order and the number of calls. */
async function walk(
	read: (paginationOpts: PaginationOptions) => Promise<Page>,
	numItems: number
): Promise<{ ids: string[]; calls: number; pages: Page[] }> {
	const ids: string[] = [];
	const pages: Page[] = [];
	let cursor: string | null = null;
	let calls = 0;
	for (let guard = 0; guard < 200; guard++) {
		const res = await read({ cursor, numItems });
		calls += 1;
		pages.push(res);
		ids.push(...res.page.map((r) => r._id));
		if (res.isDone) return { ids, calls, pages };
		cursor = res.continueCursor;
	}
	throw new Error('walk did not finish');
}

/**
 * The order `by_created_at` desc gives (createdAt, then _creationTime, then
 * id), restricted to one source, computed here rather than read back through
 * an index.
 */
async function newestFirst(t: Harness, sourceType: Source): Promise<string[]> {
	const rows = (await t.run((ctx) => ctx.db.query('semanticFiles').collect())) as Array<
		Doc<'semanticFiles'>
	>;
	return rows
		.filter((r) => r.sourceType === sourceType)
		.sort(
			(a, b) =>
				b.createdAt - a.createdAt ||
				b._creationTime - a._creationTime ||
				(a._id < b._id ? 1 : a._id > b._id ? -1 : 0)
		)
		.map((r) => r._id);
}

describe('semanticFiles schema — indexes the file reads page through', () => {
	it('adds the by-source indexes beside the existing ones, changing none', () => {
		const table = (
			schema.tables.semanticFiles as unknown as {
				export(): {
					indexes: Array<{ indexDescriptor: string; fields: string[] }>;
					searchIndexes: Array<{
						indexDescriptor: string;
						searchField: string;
						filterFields: string[];
					}>;
				};
			}
		).export();
		const index = (name: string) => table.indexes.find((i) => i.indexDescriptor === name);
		const searchIndex = (name: string) =>
			table.searchIndexes.find((i) => i.indexDescriptor === name);

		// Live `list` / `search` cursors point into these two: never change them in place.
		expect(index('by_created_at')?.fields).toEqual(['createdAt']);
		expect(searchIndex('search_files')).toEqual({
			indexDescriptor: 'search_files',
			searchField: 'searchableText',
			filterFields: [],
		});
		expect(index('by_source_and_created')?.fields).toEqual(['sourceType', 'createdAt']);
		expect(searchIndex('search_files_by_source')).toEqual({
			indexDescriptor: 'search_files_by_source',
			searchField: 'searchableText',
			filterFields: ['sourceType'],
		});
	});
});

describe('file page readers — the query each one builds', () => {
	/** A fake `ctx.db` that records the builder chain instead of running it. */
	function recordingCtx(calls: string[]): QueryCtx {
		const rangeBuilder = {
			eq(field: string, value: unknown) {
				calls.push(`eq(${field},${String(value)})`);
				return rangeBuilder;
			},
			search(field: string, text: string) {
				calls.push(`search(${field},${text})`);
				return rangeBuilder;
			},
		};
		const chain = {
			withIndex(name: string, range?: (q: typeof rangeBuilder) => unknown) {
				calls.push(`withIndex(${name})`);
				range?.(rangeBuilder);
				return chain;
			},
			withSearchIndex(name: string, range: (q: typeof rangeBuilder) => unknown) {
				calls.push(`withSearchIndex(${name})`);
				range(rangeBuilder);
				return chain;
			},
			order(direction: string) {
				calls.push(`order(${direction})`);
				return chain;
			},
			paginate() {
				calls.push('paginate');
				return Promise.resolve({ page: [], isDone: true, continueCursor: '' });
			},
		};
		return {
			db: {
				query(table: string) {
					calls.push(`query(${table})`);
					return chain;
				},
			},
		} as unknown as QueryCtx;
	}

	it('keeps each reader on its own index', async () => {
		const opts = { cursor: null, numItems: 24 };
		const record = async (run: (ctx: QueryCtx) => Promise<unknown>) => {
			const calls: string[] = [];
			await run(recordingCtx(calls));
			return calls;
		};

		expect(await record((ctx) => readers.listFilesPage(ctx, opts))).toEqual([
			'query(semanticFiles)',
			'withIndex(by_created_at)',
			'order(desc)',
			'paginate',
		]);
		expect(await record((ctx) => readers.searchFilesPage(ctx, 'report', opts))).toEqual([
			'query(semanticFiles)',
			'withSearchIndex(search_files)',
			'search(searchableText,report)',
			'paginate',
		]);
		expect(
			await record((ctx) => readers.listFilesBySourcePage(ctx, 'email_attachment', opts))
		).toEqual([
			'query(semanticFiles)',
			'withIndex(by_source_and_created)',
			'eq(sourceType,email_attachment)',
			'order(desc)',
			'paginate',
		]);
		expect(
			await record((ctx) => readers.searchFilesBySourcePage(ctx, 'report', 'upload', opts))
		).toEqual([
			'query(semanticFiles)',
			'withSearchIndex(search_files_by_source)',
			'search(searchableText,report)',
			'eq(sourceType,upload)',
			'paginate',
		]);
	});

	it('routes each endpoint to one reader, with or without a sourceType', async () => {
		const t = convexTest(schema, modules);
		await insertFile(t, 'upload', 1);
		const paginationOpts = { cursor: null, numItems: 5 };
		const spies = {
			list: vi.mocked(readers.listFilesPage),
			search: vi.mocked(readers.searchFilesPage),
			listBySource: vi.mocked(readers.listFilesBySourcePage),
			searchBySource: vi.mocked(readers.searchFilesBySourcePage),
		};
		const calledReaders = async (run: () => Promise<unknown>) => {
			vi.clearAllMocks();
			await run();
			return Object.entries(spies)
				.filter(([, spy]) => spy.mock.calls.length > 0)
				.map(([name]) => name);
		};
		const sourceType = 'upload' as const;

		for (const args of [{ paginationOpts }, { paginationOpts, sourceType }]) {
			expect(await calledReaders(() => t.query(api.files.cards.list, args))).toEqual(['list']);
			const searchArgs = { ...args, query: 'report' };
			expect(await calledReaders(() => t.query(api.files.cards.search, searchArgs))).toEqual([
				'search',
			]);
		}
		expect(
			await calledReaders(() =>
				t.query(api.files.cards.listBySource, { paginationOpts, sourceType })
			)
		).toEqual(['listBySource']);
		expect(
			await calledReaders(() =>
				t.query(api.files.cards.searchBySource, { paginationOpts, sourceType, query: 'report' })
			)
		).toEqual(['searchBySource']);
	});
});

describe('files.cards.listBySource — pages of matches', () => {
	it('returns every match in one page, ties by creation order, where the legacy page is empty', async () => {
		const t = convexTest(schema, modules);
		// Oldest: five attachments, three of them sharing one createdAt.
		const a1 = await insertFile(t, 'email_attachment', 1);
		const tie1 = await insertFile(t, 'email_attachment', 5);
		const tie2 = await insertFile(t, 'email_attachment', 5);
		const tie3 = await insertFile(t, 'email_attachment', 5);
		const a9 = await insertFile(t, 'email_attachment', 9);
		for (let i = 0; i < 30; i++) await insertFile(t, 'upload', 100 + i);

		const paginationOpts = { cursor: null, numItems: 24 };
		const filtered = await t.query(api.files.cards.listBySource, {
			paginationOpts,
			sourceType: 'email_attachment',
		});
		expect(filtered.page.map((c) => c._id)).toEqual([a9, tie3, tie2, tie1, a1]);
		expect(filtered.isDone).toBe(true);

		// What N-1 clients page through: the post-pagination filter, unchanged.
		const legacy = await t.query(api.files.cards.list, {
			paginationOpts,
			sourceType: 'email_attachment',
		});
		expect(legacy.page).toEqual([]);
		expect(legacy.isDone).toBe(false);
	});

	it('collects K matches in ceil(K / pageSize) calls', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 5; i++) await insertFile(t, 'agent_generated', i);
		for (let i = 0; i < 12; i++) await insertFile(t, 'upload', 100 + i);
		const sourceType = 'agent_generated' as const;

		const indexed = await walk(
			(paginationOpts) => t.query(api.files.cards.listBySource, { paginationOpts, sourceType }),
			2
		);
		expect(indexed.ids).toHaveLength(5);
		expect(indexed.calls).toBe(3);

		// Report only: the legacy path's cost on the same fixture.
		const legacy = await walk(
			(paginationOpts) => t.query(api.files.cards.list, { paginationOpts, sourceType }),
			2
		);
		expect(legacy.ids).toEqual(indexed.ids);
		process.stdout.write(
			`[files.cards by source] 5 matches behind 12 newer rows, page size 2: ` +
				`listBySource ${indexed.calls} calls, list+sourceType ${legacy.calls} calls\n`
		);
	});

	it('walks its own cursors to the end in by_created_at order, across ties and new rows', async () => {
		const t = convexTest(schema, modules);
		for (const createdAt of [1, 2, 2, 2, 3, 4, 4, 5]) await insertFile(t, 'upload', createdAt);
		for (let i = 0; i < 6; i++) await insertFile(t, 'email_attachment', i * 2);
		const sourceType = 'upload' as const;
		const expected = await newestFirst(t, sourceType);

		const ids: string[] = [];
		let cursor: string | null = null;
		let inserted: { newer: string; older: string } | null = null;
		for (let guard = 0; guard < 20; guard++) {
			const res: Page = await t.query(api.files.cards.listBySource, {
				paginationOpts: { cursor, numItems: 2 },
				sourceType,
			});
			ids.push(...res.page.map((r) => r._id));
			if (res.isDone) break;
			cursor = res.continueCursor;
			if (!inserted) {
				// Between pages: a row newer than the cursor stays behind it; an
				// older one is still ahead.
				inserted = {
					newer: await insertFile(t, 'upload', 50),
					older: await insertFile(t, 'upload', 0),
				};
			}
		}

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain(inserted!.newer);
		expect(ids).toEqual([...expected, inserted!.older]);
	});

	it('rejects a missing or unknown sourceType', async () => {
		const t = convexTest(schema, modules);
		const paginationOpts = { cursor: null, numItems: 2 };
		await expect(
			t.query(api.files.cards.listBySource, { paginationOpts } as never)
		).rejects.toThrow();
		await expect(
			t.query(api.files.cards.listBySource, { paginationOpts, sourceType: 'fax' } as never)
		).rejects.toThrow();
		await expect(
			t.query(api.files.cards.searchBySource, { paginationOpts, query: 'report' } as never)
		).rejects.toThrow();
	});
});

describe('files.cards.searchBySource — filtered full-text search', () => {
	it('walks every match of the source exactly once, the same set the legacy filter reaches', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 9; i++) await insertFile(t, 'upload', 100 + i);
		for (let i = 0; i < 5; i++) await insertFile(t, 'email_attachment', i);
		const sourceType = 'email_attachment' as const;

		const indexed = await walk(
			(paginationOpts) =>
				t.query(api.files.cards.searchBySource, { paginationOpts, query: 'quarterly', sourceType }),
			2
		);
		expect(new Set(indexed.ids).size).toBe(indexed.ids.length);
		expect(indexed.pages.flatMap((p) => p.page).every((c) => c.sourceType === sourceType)).toBe(
			true
		);
		// convex-test returns search hits in its own order, so compare sets.
		expect([...indexed.ids].sort()).toEqual([...(await newestFirst(t, sourceType))].sort());

		const legacy = await walk(
			(paginationOpts) =>
				t.query(api.files.cards.search, { paginationOpts, query: 'quarterly', sourceType }),
			2
		);
		expect([...legacy.ids].sort()).toEqual([...indexed.ids].sort());
		expect(legacy.calls).toBeGreaterThan(indexed.calls);
	});
});

describe('files.cards.list — a sourceType filter keeps its index', () => {
	it('walks list + sourceType to every match of the source, newest first', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 7; i++) {
			await insertFile(t, i % 2 === 0 ? 'upload' : 'email_attachment', i);
		}
		const sourceType = 'upload' as const;

		const cards = await walk(
			(paginationOpts) => t.query(api.files.cards.list, { paginationOpts, sourceType }),
			2
		);
		expect(cards.ids).toEqual(await newestFirst(t, sourceType));
	});
});

describe('files.cards by source — a first page the read gate empties', () => {
	async function seedGated(t: Harness) {
		await enableFeatures(t, ['postbox']);
		return t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'victim',
				organizationId: 'test-org',
				address: 'victim@example.com',
				domain: 'example.com',
				status: 'active',
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			const file = (createdAt: number, extra: Partial<Doc<'semanticFiles'>>) =>
				ctx.db.insert('semanticFiles', {
					filename: `attachment-${createdAt}.txt`,
					mimeType: 'text/plain',
					fileSize: 10,
					sourceType: 'email_attachment',
					version: 1,
					embedding: [],
					searchableText: `confidential attachment ${createdAt}`,
					createdAt,
					updatedAt: createdAt,
					...extra,
				});
			// Newest three: Team Inbox captures, owner/admin only. Inserted first
			// too, so they lead both the by-date order and convex-test's search
			// order (insertion order; it does not rank by relevance).
			for (const at of [10, 11, 12]) await file(at, { captureSource: 'team_inbox' });
			// Older: captured in the editor's own mailbox, so readable.
			const readable: string[] = [];
			for (const at of [1, 2]) {
				readable.push(await file(at, { captureSource: 'mailbox', sourceMailboxId: mailboxId }));
			}
			return readable;
		});
	}

	it('returns an empty page with more to load, then the readable files (list and search)', async () => {
		const t = convexTest(schema, modules);
		const readable = await seedGated(t);
		sessionMock.userId = 'victim';
		sessionMock.role = 'editor';
		const sourceType = 'email_attachment' as const;

		const reads: Array<(paginationOpts: PaginationOptions) => Promise<Page>> = [
			(paginationOpts) => t.query(api.files.cards.listBySource, { paginationOpts, sourceType }),
			(paginationOpts) =>
				t.query(api.files.cards.searchBySource, {
					paginationOpts,
					query: 'confidential',
					sourceType,
				}),
		];
		for (const read of reads) {
			const result = await walk(read, 3);
			expect(result.pages[0]!.page).toEqual([]);
			expect(result.pages[0]!.isDone).toBe(false);
			expect([...result.ids].sort()).toEqual([...readable].sort());
		}
	});
});
