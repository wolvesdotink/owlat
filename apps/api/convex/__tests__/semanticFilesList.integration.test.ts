import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// `authedQuery` gates on `requireOrgMember`; stub it so `list`/`search` run as
// an authenticated org member without a full BetterAuth session.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Source = 'upload' | 'email_attachment' | 'agent_generated';

async function insertFile(
	t: ReturnType<typeof convexTest>,
	sourceType: Source,
	createdAt: number,
	searchableText: string,
): Promise<Id<'semanticFiles'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([searchableText])));
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: `${searchableText}.txt`,
			mimeType: 'text/plain',
			fileSize: searchableText.length,
			sourceType,
			version: 1,
			embedding: [],
			searchableText,
			createdAt,
			updatedAt: createdAt,
		}),
	);
}

const PAGE = { cursor: null, numItems: 2 };

describe('semanticFiles.list — pagination', () => {
	it('paginates past the first page instead of hard-capping the result', async () => {
		const t = convexTest(schema, modules);
		// Five files — more than one page of 2.
		for (let i = 0; i < 5; i++) {
			await insertFile(t, 'upload', 1000 + i, `file ${i}`);
		}

		const first = await t.query(api.semanticFiles.list, { paginationOpts: PAGE });
		expect(first.page).toHaveLength(2);
		expect(first.isDone).toBe(false);
		// Newest first.
		expect(first.page[0]!.searchableText).toBe('file 4');
		// Storage URL is hydrated for each row.
		expect(first.page[0]).toHaveProperty('url');

		const second = await t.query(api.semanticFiles.list, {
			paginationOpts: { cursor: first.continueCursor, numItems: 2 },
		});
		expect(second.page).toHaveLength(2);
		expect(second.isDone).toBe(false);

		const third = await t.query(api.semanticFiles.list, {
			paginationOpts: { cursor: second.continueCursor, numItems: 2 },
		});
		expect(third.page).toHaveLength(1);
		expect(third.isDone).toBe(true);
	});

	it('filters by sourceType across the whole table, not just one fetched page', async () => {
		const t = convexTest(schema, modules);
		// Newest 4 rows are uploads; the lone email attachment is the oldest, so a
		// client-side filter over only the newest page would never surface it.
		await insertFile(t, 'email_attachment', 1, 'old attachment');
		for (let i = 0; i < 4; i++) {
			await insertFile(t, 'upload', 100 + i, `upload ${i}`);
		}

		// Walk pages of 2 with the backend filter; collect all email_attachment hits.
		const collected: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const res: { page: Array<{ searchableText?: string }>; isDone: boolean; continueCursor: string } =
				await t.query(api.semanticFiles.list, {
					paginationOpts: { cursor, numItems: 2 },
					sourceType: 'email_attachment',
				});
			for (const f of res.page) if (f.searchableText) collected.push(f.searchableText);
			if (res.isDone) break;
			cursor = res.continueCursor;
		}

		expect(collected).toEqual(['old attachment']);
	});
});

describe('semanticFiles.search — pagination + sourceType', () => {
	it('full-text searches with a backend sourceType filter', async () => {
		const t = convexTest(schema, modules);
		await insertFile(t, 'upload', 1, 'quarterly report upload');
		await insertFile(t, 'email_attachment', 2, 'quarterly report attachment');

		const res = await t.query(api.semanticFiles.search, {
			paginationOpts: { cursor: null, numItems: 10 },
			query: 'quarterly report',
			sourceType: 'email_attachment',
		});

		expect(res.page).toHaveLength(1);
		expect(res.page[0]!.sourceType).toBe('email_attachment');
	});
});
