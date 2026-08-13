import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// `authedQuery`/`authedMutation` gate on the session helpers; stub them so the
// file queries and the admin-only `update`/`create` run as an org owner.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireAdminContext: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue(session.userId),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

const PAGE = { cursor: null, numItems: 20 };

/** Upload a file through the real `create` mutation (searchableText included). */
async function uploadFile(
	t: Harness,
	args: { filename: string; title?: string; tags?: string[] }
): Promise<Id<'semanticFiles'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['body'])));
	return t.mutation(api.semanticFiles.create, {
		storageId,
		filename: args.filename,
		mimeType: 'text/plain',
		fileSize: 4,
		title: args.title,
		tags: args.tags,
		sourceType: 'upload',
	});
}

async function searchIds(t: Harness, query: string): Promise<Id<'semanticFiles'>[]> {
	const result = await t.query(api.semanticFiles.search, { paginationOpts: PAGE, query });
	return result.page.map((f) => f._id);
}

describe('semanticFiles.search — what the index covers', () => {
	it('finds a file by a tag typed at upload, not just its filename', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, {
			filename: 'scan001.pdf',
			title: 'Signed copy',
			tags: ['invoice', 'acme'],
		});
		await uploadFile(t, { filename: 'unrelated.txt' });

		expect(await searchIds(t, 'invoice')).toEqual([fileId]);
		expect(await searchIds(t, 'acme')).toEqual([fileId]);
		// The filename and upload-time title still match.
		expect(await searchIds(t, 'scan001.pdf')).toEqual([fileId]);
		expect(await searchIds(t, 'signed')).toEqual([fileId]);
	});

	it('finds a file by its AI summary, auto-tags and extracted text', async () => {
		const t = convexTest(schema, modules);
		// Stand in for a processed row: the pipeline writes these fields plus the
		// rebuilt searchableText, which is what the index actually reads.
		const fileId = await uploadFile(t, { filename: 'notes.txt' });
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			summary: 'Quarterly revenue review for the northern region.',
			extractedText: 'Revenue grew by 12% thanks to the Zephyr launch.',
			autoTags: ['finance'],
			embedding: [],
			searchableText:
				'notes.txt Quarterly revenue review for the northern region. finance Revenue grew by 12% thanks to the Zephyr launch.',
		});

		expect(await searchIds(t, 'quarterly')).toEqual([fileId]);
		expect(await searchIds(t, 'finance')).toEqual([fileId]);
		expect(await searchIds(t, 'zephyr')).toEqual([fileId]);
	});

	it('reindexes on a tag edit so the new tag matches and the old one does not', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, { filename: 'doc.txt', tags: ['draft'] });
		expect(await searchIds(t, 'draft')).toEqual([fileId]);

		await t.mutation(api.semanticFiles.update, { fileId, tags: ['approved'] });

		expect(await searchIds(t, 'approved')).toEqual([fileId]);
		expect(await searchIds(t, 'draft')).toEqual([]);
	});

	it('reindexes on a title edit without dropping the summary from the index', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, { filename: 'doc.txt' });
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			summary: 'Onboarding checklist for new hires.',
			embedding: [],
			searchableText: 'doc.txt Onboarding checklist for new hires.',
		});

		await t.mutation(api.semanticFiles.update, { fileId, title: 'Handbook' });

		expect(await searchIds(t, 'handbook')).toEqual([fileId]);
		expect(await searchIds(t, 'onboarding')).toEqual([fileId]);
	});

	it('respects the source filter while searching', async () => {
		const t = convexTest(schema, modules);
		const uploadId = await uploadFile(t, { filename: 'report.txt', tags: ['ledger'] });
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
		await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				storageId,
				filename: 'attachment.txt',
				mimeType: 'text/plain',
				fileSize: 1,
				sourceType: 'email_attachment',
				version: 1,
				embedding: [],
				searchableText: 'attachment.txt ledger',
				createdAt: 1,
				updatedAt: 1,
			})
		);

		const uploads = await t.query(api.semanticFiles.search, {
			paginationOpts: PAGE,
			query: 'ledger',
			sourceType: 'upload',
		});
		expect(uploads.page.map((f) => f._id)).toEqual([uploadId]);
	});
});

describe('semanticFiles.update — conversation linking', () => {
	async function insertThread(t: Harness, subject: string): Promise<Id<'conversationThreads'>> {
		return t.run((ctx) =>
			ctx.db.insert('conversationThreads', {
				subject,
				normalizedSubject: subject.toLowerCase(),
				contactIdentifier: 'sender@example.com',
				status: 'open',
				messageCount: 1,
				firstMessageAt: 1,
				lastMessageAt: 1,
				createdAt: 1,
			})
		);
	}

	it('links a file to a thread and surfaces the subject on the detail read', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, { filename: 'quote.txt' });
		const threadId = await insertThread(t, 'Renewal quote');

		await t.mutation(api.semanticFiles.update, { fileId, threadId });

		const file = await t.query(api.semanticFiles.get, { fileId });
		expect(file?.threadId).toBe(threadId);
		expect(file?.threadSubject).toBe('Renewal quote');
	});

	it('clears the link when threadId is null, and leaves it alone when omitted', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, { filename: 'quote.txt' });
		const threadId = await insertThread(t, 'Renewal quote');
		await t.mutation(api.semanticFiles.update, { fileId, threadId });

		// An unrelated edit must not disturb the link.
		await t.mutation(api.semanticFiles.update, { fileId, title: 'Quote' });
		expect((await t.query(api.semanticFiles.get, { fileId }))?.threadId).toBe(threadId);

		await t.mutation(api.semanticFiles.update, { fileId, threadId: null });
		const cleared = await t.query(api.semanticFiles.get, { fileId });
		expect(cleared?.threadId).toBeUndefined();
		expect(cleared?.threadSubject).toBeUndefined();
	});

	it('rejects a link to a thread that no longer exists', async () => {
		const t = convexTest(schema, modules);
		const fileId = await uploadFile(t, { filename: 'quote.txt' });
		const threadId = await insertThread(t, 'Deleted thread');
		await t.run((ctx) => ctx.db.delete(threadId));

		await expect(t.mutation(api.semanticFiles.update, { fileId, threadId })).rejects.toThrow(
			/Conversation not found/
		);
	});
});

describe('migration 0038 — rebuild searchableText', () => {
	it('reindexes legacy rows whose payload predates tags/summary', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
		const fileId = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				storageId,
				filename: 'legacy.txt',
				mimeType: 'text/plain',
				fileSize: 1,
				tags: ['payroll'],
				summary: 'Headcount plan for the Zurich office.',
				sourceType: 'upload',
				version: 1,
				embedding: [],
				// The pre-migration shape: filename + title only.
				searchableText: 'legacy.txt ',
				createdAt: 1,
				updatedAt: 1,
			})
		);
		expect(await searchIds(t, 'payroll')).toEqual([]);

		const result = await t.mutation(
			internal.migrations['0038_rebuild_file_search_text'].rebuildPage,
			{ cursor: null }
		);
		expect(result.rebuilt).toBe(1);
		expect(result.isDone).toBe(true);

		expect(await searchIds(t, 'payroll')).toEqual([fileId]);
		expect(await searchIds(t, 'zurich')).toEqual([fileId]);

		// Idempotent: a second pass finds nothing left to rewrite.
		const second = await t.mutation(
			internal.migrations['0038_rebuild_file_search_text'].rebuildPage,
			{ cursor: null }
		);
		expect(second.rebuilt).toBe(0);
	});
});
