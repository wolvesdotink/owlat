import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { listResources, countFacet } from '../listing';
import { contactListing } from '../../contacts/listing';
import { campaignListing } from '../../campaigns/listing';
import { emailTemplateListing } from '../../emailTemplates/listing';
import { topicListing } from '../../topics/listing';
import { segmentListing } from '../../segments/listing';
import { automationListing } from '../../automations/listing';
import type { GroupedCount } from '../listing';

// The engine is auth-agnostic, so it is tested directly against a seeded
// `DatabaseReader` via `t.run` — no deployment, no per-query auth shell.
const modules = import.meta.glob('../../**/*.*s');

function contact(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		source: 'api' as const,
		doiStatus: 'not_required' as const,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

const PAGE = { numItems: 25, cursor: null };

describe('listResources — cursor regression (the headline ADR-0037 fix)', () => {
	it('search is genuinely multi-page: page 2 uses the real cursor and returns NEW rows', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('contacts', contact({
					email: `match${i}@example.com`,
					searchableText: `findme person ${i}`,
				}));
			}
		});

		const seen = await t.run(async (ctx) => {
			const ids = new Set<string>();
			let cursor: string | null = null;
			let pages = 0;
			let done = false;
			// Walk every page via the returned cursor. The pre-ADR bug returned the
			// literal 'search' sentinel and re-served page 1 forever, so this loop
			// would never terminate / never grow the set.
			while (!done) {
				const opts: { numItems: number; cursor: string | null } = { numItems: 2, cursor };
				const result = await listResources(ctx.db, contactListing, {
					search: 'findme',
					paginationOpts: opts,
				});
				expect(result.page.length).toBeLessThanOrEqual(2);
				for (const row of result.page) ids.add(row._id);
				pages++;
				done = result.isDone;
				cursor = result.continueCursor;
				expect(cursor).not.toBe('search'); // the sentinel is gone
				if (pages > 10) throw new Error('cursor did not advance — single-page bug');
			}
			return { count: ids.size, pages };
		});

		// All 5 distinct rows, across more than one page.
		expect(seen.count).toBe(5);
		expect(seen.pages).toBeGreaterThan(1);
	});
});

describe('listResources — index selection', () => {
	it('search present ⇒ relevance/search path returns only matching rows', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'a@x.com', searchableText: 'apple pie' }));
			await ctx.db.insert('contacts', contact({ email: 'b@x.com', searchableText: 'banana split' }));
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { search: 'apple', paginationOpts: PAGE }),
		);
		expect(result.page).toHaveLength(1);
		expect(result.page[0]!.email).toBe('a@x.com');
	});

	it('search absent ⇒ browse path honours the descriptor order (createdAt desc)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'old@x.com', createdAt: 1_000 }));
			await ctx.db.insert('contacts', contact({ email: 'new@x.com', createdAt: 2_000 }));
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { paginationOpts: PAGE }),
		);
		expect(result.page.map((c) => c.email)).toEqual(['new@x.com', 'old@x.com']);
	});

	it('browse-path `order` arg flips the descriptor direction (contacts createdAt asc)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'old@x.com', createdAt: 1_000 }));
			await ctx.db.insert('contacts', contact({ email: 'new@x.com', createdAt: 2_000 }));
		});
		// Default order is desc; an explicit asc override must reverse it while
		// soft-delete still rides the index.
		const asc = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { sort: 'createdAt', order: 'asc', paginationOpts: PAGE }),
		);
		expect(asc.page.map((c) => c.email)).toEqual(['old@x.com', 'new@x.com']);

		const desc = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { sort: 'createdAt', order: 'desc', paginationOpts: PAGE }),
		);
		expect(desc.page.map((c) => c.email)).toEqual(['new@x.com', 'old@x.com']);
	});

	it('browse-path equality filter is served index-natively (campaign status)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('campaigns', { name: 'A', status: 'draft', createdAt: 1, updatedAt: 1 });
			await ctx.db.insert('campaigns', { name: 'B', status: 'sent', createdAt: 2, updatedAt: 2 });
			await ctx.db.insert('campaigns', { name: 'C', status: 'draft', createdAt: 3, updatedAt: 3 });
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, campaignListing, { filters: { status: 'draft' }, paginationOpts: PAGE }),
		);
		expect(result.page).toHaveLength(2);
		expect(result.page.every((c) => c.status === 'draft')).toBe(true);
	});
});

describe('listResources — soft-delete rides the index', () => {
	it('deleted rows never appear on the browse path', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'live1@x.com' }));
			await ctx.db.insert('contacts', contact({ email: 'live2@x.com' }));
			await ctx.db.insert('contacts', contact({ email: 'gone@x.com', deletedAt: Date.now() }));
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { paginationOpts: PAGE }),
		);
		expect(result.page).toHaveLength(2);
		expect(result.page.some((c) => c.email === 'gone@x.com')).toBe(false);
	});

	it('deleted rows never appear on the search path', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'live@x.com', searchableText: 'zephyr live' }));
			await ctx.db.insert('contacts', contact({ email: 'gone@x.com', searchableText: 'zephyr gone', deletedAt: Date.now() }));
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { search: 'zephyr', paginationOpts: PAGE }),
		);
		expect(result.page).toHaveLength(1);
		expect(result.page[0]!.email).toBe('live@x.com');
	});

	it('does not thin a page below numItems when deleted rows exist', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) await ctx.db.insert('contacts', contact({ email: `live${i}@x.com` }));
			for (let i = 0; i < 3; i++) await ctx.db.insert('contacts', contact({ email: `gone${i}@x.com`, deletedAt: Date.now() }));
		});
		// 3 live rows exist; a page of 2 must be full (deleted rows must not eat slots).
		const result = await t.run((ctx) =>
			listResources(ctx.db, contactListing, { paginationOpts: { numItems: 2, cursor: null } }),
		);
		expect(result.page).toHaveLength(2);
		expect(result.page.every((c) => c.deletedAt === undefined)).toBe(true);
		expect(result.isDone).toBe(false);
	});
});

describe('listResources — enrichment', () => {
	it('uses the cached counter when present (O(1) topic enrichment)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('topics', { name: 'Cached', cachedMemberCount: 42, createdAt: Date.now() });
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, topicListing, { paginationOpts: PAGE }),
		);
		expect(result.page[0]!.contactCount).toBe(42);
	});

	it('falls back to a membership scan when the cache is absent', async () => {
		const t = convexTest(schema, modules);
		const topicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', { name: 'Uncached', createdAt: Date.now() });
			const c1 = await ctx.db.insert('contacts', contact({ email: 'm1@x.com' }));
			const c2 = await ctx.db.insert('contacts', contact({ email: 'm2@x.com' }));
			await ctx.db.insert('contactTopics', { topicId: id, contactId: c1, addedAt: Date.now() });
			await ctx.db.insert('contactTopics', { topicId: id, contactId: c2, addedAt: Date.now() });
			return id;
		});
		const result = await t.run((ctx) =>
			listResources(ctx.db, topicListing, { paginationOpts: PAGE }),
		);
		const row = result.page.find((tpc) => tpc._id === topicId)!;
		expect(row.contactCount).toBe(2);
	});
});

describe('countFacet — the count zoo collapses', () => {
	it('cachedCounter reads the instanceSettings singleton', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { contactCount: 7, createdAt: Date.now() });
		});
		const total = await t.run((ctx) => countFacet(ctx.db, contactListing, 'total'));
		expect(total).toBe(7);
	});

	it('cachedCounter falls back to a scan when no counter row exists', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', contact({ email: 'one@x.com' }));
			await ctx.db.insert('contacts', contact({ email: 'two@x.com' }));
		});
		const total = await t.run((ctx) => countFacet(ctx.db, contactListing, 'total'));
		expect(total).toBe(2);
	});

	it('indexCount counts the whole table', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('segments', { name: 'S1', filters: { logic: 'AND', conditions: [] }, createdAt: 1, updatedAt: 1 });
			await ctx.db.insert('segments', { name: 'S2', filters: { logic: 'AND', conditions: [] }, createdAt: 2, updatedAt: 2 });
		});
		const total = await t.run((ctx) => countFacet(ctx.db, segmentListing, 'total'));
		expect(total).toBe(2);
	});

	it('groupBy returns per-bucket counts whose total is their sum', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('campaigns', { name: 'A', status: 'draft', createdAt: 1, updatedAt: 1 });
			await ctx.db.insert('campaigns', { name: 'B', status: 'draft', createdAt: 2, updatedAt: 2 });
			await ctx.db.insert('campaigns', { name: 'C', status: 'sent', createdAt: 3, updatedAt: 3 });
		});
		const counts = (await t.run((ctx) =>
			countFacet(ctx.db, campaignListing, 'byStatus'),
		)) as GroupedCount;
		expect(counts['draft']).toBe(2);
		expect(counts['sent']).toBe(1);
		expect(counts['scheduled']).toBe(0);
		expect(counts.total).toBe(3);
		const summed = counts['draft']! + counts['scheduled']! + counts['sending']! + counts['sent']! + counts['cancelled']! + counts['pending_review']!;
		expect(summed).toBe(counts.total);
	});
});

describe('descriptors — smoke', () => {
	it('every descriptor lists without error against an empty deployment', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const empty = <T extends { page: unknown[]; isDone: boolean }>(result: T) => {
				expect(result.page).toEqual([]);
				expect(result.isDone).toBe(true);
			};
			empty(await listResources(ctx.db, contactListing, { paginationOpts: PAGE }));
			empty(await listResources(ctx.db, campaignListing, { paginationOpts: PAGE }));
			empty(await listResources(ctx.db, emailTemplateListing, { paginationOpts: PAGE }));
			empty(await listResources(ctx.db, topicListing, { paginationOpts: PAGE }));
			empty(await listResources(ctx.db, segmentListing, { paginationOpts: PAGE }));
			empty(await listResources(ctx.db, automationListing, { paginationOpts: PAGE }));
		});
	});
});
