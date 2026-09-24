import { convexTest } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { api } from '../_generated/api';
import { MAX_LIBRARY_FILE_BYTES } from '@owlat/shared/attachments';
vi.mock('@owlat/shared/attachments', async () => ({
	...(await vi.importActual('@owlat/shared/attachments')),
	MAX_LIBRARY_FILE_BYTES: 32,
}));

/**
 * `semanticFiles.create` advertises a fixed per-file upload ceiling
 * (`MAX_LIBRARY_FILE_BYTES`, surfaced in the upload modal copy). The client
 * guards on it too, but a forged request must not get past the server, so admission uses immutable system metadata rather than the claimed size.
 */
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// The `authedMutation` wrapper enforces org membership via this, and the
		// `create` handler then re-checks the admin role through it as well.
		getMutationContext: vi
			.fn()
			.mockResolvedValue({ userId: 'admin-user', role: 'owner', activeOrganizationId: 'org-1' }),
		requireAdminContext: vi
			.fn()
			.mockResolvedValue({ userId: 'admin-user', role: 'owner', activeOrganizationId: 'org-1' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

// File processing is excluded above (it needs the LLM stack); deleting a file
// still schedules it, and it fails to resolve when it runs.
beforeEach(() => expectScheduledFailure('semanticFileProcessing:processFile'));

const testUser = { subject: 'admin-user', issuer: 'test', tokenIdentifier: 'test|admin-user' };

describe('semanticFiles.create — size ceiling', () => {
	it('rejects a file larger than the upload limit and inserts no row', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array(MAX_LIBRARY_FILE_BYTES + 1)]))
		);

		await expect(
			t.mutation(api.semanticFiles.create, {
				storageId,
				filename: 'huge.pdf',
				mimeType: 'application/pdf',
				fileSize: 1,
				sourceType: 'upload',
			})
		).rejects.toThrow(/upload limit/);

		const rows = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(rows).toHaveLength(0);
	});

	it('accepts a file at exactly the limit', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array(MAX_LIBRARY_FILE_BYTES)]))
		);
		await t.run((ctx) => recordUploadedBlob(ctx, storageId, 'admin-user'));

		const fileId = await t.mutation(api.semanticFiles.create, {
			storageId,
			filename: 'contract.pdf',
			mimeType: 'application/pdf',
			fileSize: MAX_LIBRARY_FILE_BYTES,
			sourceType: 'upload',
		});

		const row = await t.run((ctx) => ctx.db.get(fileId));
		expect(row?.fileSize).toBe(MAX_LIBRARY_FILE_BYTES);
		await t.mutation(api.semanticFiles.remove, { fileId });
		expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(false);
	});

	it("deleting a legacy file alias preserves another resource's blob", async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['new upload'])));
		await t.run((ctx) => recordUploadedBlob(ctx, storageId, 'admin-user'));
		const fileId = await t.mutation(api.semanticFiles.create, {
			storageId,
			filename: 'file.txt',
			mimeType: 'text/plain',
			fileSize: 10,
			sourceType: 'upload',
		});
		const foreignId = await t.run((ctx) => ctx.storage.store(new Blob(['private original'])));
		// Model a row persisted before upload ownership was enforced.
		await t.run((ctx) => ctx.db.patch(fileId, { storageId: foreignId }));
		await t.mutation(api.semanticFiles.remove, { fileId });
		expect(await t.run(async (ctx) => (await ctx.storage.get(foreignId)) !== null)).toBe(true);
	});
});
