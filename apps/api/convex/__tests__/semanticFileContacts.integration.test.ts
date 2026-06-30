import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { syncFileContacts } from '../semanticFiles';

const modules = import.meta.glob('../**/*.*s');

async function newContact(ctx: MutationCtx, email: string): Promise<Id<'contacts'>> {
	return ctx.db.insert('contacts', {
		email,
		source: 'api',
		doiStatus: 'not_required',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
}

async function newFile(
	ctx: MutationCtx,
	storageId: Id<'_storage'>,
	createdAt: number,
): Promise<Id<'semanticFiles'>> {
	return ctx.db.insert('semanticFiles', {
		storageId,
		filename: 'f.pdf',
		mimeType: 'application/pdf',
		fileSize: 1,
		sourceType: 'upload',
		version: 1,
		embedding: [],
		searchableText: 'f',
		createdAt,
		updatedAt: createdAt,
	});
}

async function fileIdsForContact(ctx: MutationCtx, contactId: Id<'contacts'>): Promise<Id<'semanticFiles'>[]> {
	const links = await ctx.db
		.query('semanticFileContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect();
	return links.map((l) => l.fileId);
}

describe('semanticFileContacts junction', () => {
	it('syncFileContacts reconciles add / edit / teardown and de-dups', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['x']));
			const c1 = await newContact(ctx, 'a@x.com');
			const c2 = await newContact(ctx, 'b@x.com');
			const file = await newFile(ctx, storageId, Date.now());

			// Add — a repeated contactId yields one row.
			await syncFileContacts(ctx, file, [c1, c2, c1]);
			expect((await fileIdsForContact(ctx, c1))).toEqual([file]);
			expect((await fileIdsForContact(ctx, c2))).toEqual([file]);
			expect((await ctx.db.query('semanticFileContacts').collect()).length).toBe(2);

			// Edit — drop c2.
			await syncFileContacts(ctx, file, [c1]);
			expect((await fileIdsForContact(ctx, c1))).toEqual([file]);
			expect((await fileIdsForContact(ctx, c2))).toEqual([]);

			// Teardown.
			await syncFileContacts(ctx, file, undefined);
			expect((await ctx.db.query('semanticFileContacts').collect()).length).toBe(0);
		});
	});

	it('lookup-by-contact finds a file even when it is not among the newest 200', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['x']));
			const target = await newContact(ctx, 'target@x.com');

			// One OLD file linked to the target.
			const oldFile = await newFile(ctx, storageId, 1_000);
			await syncFileContacts(ctx, oldFile, [target]);

			// 250 newer, unrelated files — these would push oldFile past the old
			// newest-200 scan window, where the JS-filter approach silently dropped it.
			for (let i = 0; i < 250; i++) await newFile(ctx, storageId, 2_000 + i);

			expect(await fileIdsForContact(ctx, target)).toEqual([oldFile]);
		});
	});
});
