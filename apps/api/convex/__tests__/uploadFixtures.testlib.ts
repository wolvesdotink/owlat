import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/** Model the receipt written by the HTTP upload, for tests not exercising transport. */
export async function recordUploadedBlob(
	ctx: MutationCtx,
	storageId: Id<'_storage'>,
	userId: string,
	organizationId = 'org-1'
) {
	return ctx.db.insert('storageUploads', {
		userId,
		organizationId,
		storageId,
		status: 'uploaded',
		expiresAt: Date.now() + 60 * 60 * 1000,
	});
}
