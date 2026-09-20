import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';

/** Existing chat uploads carry this reserved tag, including legacy rows.
 * Library writes must never remove it: downloads belong to the message's room.
 */
export function isChatAttachment(asset: Pick<Doc<'mediaAssets'>, 'tags'>): boolean {
	return asset.tags?.includes('chat-attachment') ?? false;
}

/** A second media row must not turn private chat bytes into a shared asset. */
export async function assertUnregisteredMediaStorage(
	ctx: MutationCtx,
	storageId: Id<'_storage'>
): Promise<void> {
	const existing = await ctx.db
		.query('mediaAssets')
		.withIndex('by_storage_id', (q) => q.eq('storageId', storageId))
		.first();
	if (existing) throwInvalidInput('This file is already registered');
}
