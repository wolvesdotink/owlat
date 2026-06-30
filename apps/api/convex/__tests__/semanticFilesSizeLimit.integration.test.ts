import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { MAX_LIBRARY_FILE_BYTES } from '@owlat/shared/attachments';

/**
 * `semanticFiles.create` advertises a fixed per-file upload ceiling
 * (`MAX_LIBRARY_FILE_BYTES`, surfaced in the upload modal copy). The client
 * guards on it too, but a forged request must not get past the server, so the
 * mutation rejects an oversized `fileSize` before it ever inserts a row.
 */
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// The `authedMutation` wrapper enforces org membership via this, and the
		// `create` handler then re-checks the admin role through it as well.
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

const testUser = { subject: 'admin-user', issuer: 'test', tokenIdentifier: 'test|admin-user' };

describe('semanticFiles.create — size ceiling', () => {
	it('rejects a file larger than the upload limit and inserts no row', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));

		await expect(
			t.mutation(api.semanticFiles.create, {
				storageId,
				filename: 'huge.pdf',
				mimeType: 'application/pdf',
				fileSize: MAX_LIBRARY_FILE_BYTES + 1,
				sourceType: 'upload',
			}),
		).rejects.toThrow(/upload limit/);

		const rows = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(rows).toHaveLength(0);
	});

	it('accepts a file at exactly the limit', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['contract text'])));

		const fileId = await t.mutation(api.semanticFiles.create, {
			storageId,
			filename: 'contract.pdf',
			mimeType: 'application/pdf',
			fileSize: MAX_LIBRARY_FILE_BYTES,
			sourceType: 'upload',
		});

		const row = await t.run((ctx) => ctx.db.get(fileId));
		expect(row?.fileSize).toBe(MAX_LIBRARY_FILE_BYTES);
	});
});
