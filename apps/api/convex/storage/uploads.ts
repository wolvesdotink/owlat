import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { getRequired } from '../lib/env';
import { throwForbidden } from '../_utils/errors';

type UploadSession = { userId: string; activeOrganizationId: string };
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Same browser POST contract as a native upload URL, with server-owned provenance. */
export async function mintUploadUrl(ctx: MutationCtx, session: UploadSession): Promise<string> {
	const siteUrl = getRequired('SITE_URL').replace(/\/$/, '');
	const token = crypto.randomUUID();
	await ctx.db.insert('storageUploads', {
		token,
		userId: session.userId,
		organizationId: session.activeOrganizationId,
		expiresAt: Date.now() + UPLOAD_TTL_MS,
		status: 'pending',
	});
	return `${siteUrl}/api/storage/upload?token=${token}`;
}

/** Claim before reading bytes: concurrent/replayed requests cannot reuse a ticket. */
export const begin = internalMutation({
	args: { token: v.string() },
	handler: async (ctx, args): Promise<Id<'storageUploads'> | null> => {
		const ticket = await ctx.db
			.query('storageUploads')
			.withIndex('by_token', (q) => q.eq('token', args.token))
			.unique();
		if (!ticket || ticket.status !== 'pending' || (ticket.expiresAt ?? 0) <= Date.now())
			return null;
		await ctx.db.patch(ticket._id, {
			token: undefined,
			status: 'uploading',
			expiresAt: Date.now() + UPLOAD_TTL_MS,
		});
		return ticket._id;
	},
});

export const finish = internalMutation({
	args: { uploadId: v.id('storageUploads'), storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		const ticket = await ctx.db.get(args.uploadId);
		if (!ticket || ticket.status !== 'uploading' || (ticket.expiresAt ?? 0) <= Date.now()) {
			throwForbidden('Upload expired');
		}
		await ctx.db.patch(ticket._id, {
			storageId: args.storageId,
			status: 'uploaded',
			expiresAt: Date.now() + UPLOAD_TTL_MS,
		});
	},
});

/** Only the trusted upload proxy may supply an uncommitted native upload id. */
export const abort = internalMutation({
	args: { uploadId: v.id('storageUploads'), storageId: v.optional(v.id('_storage')) },
	handler: async (ctx, args) => {
		const ticket = await ctx.db.get(args.uploadId);
		// A lost success response must never turn an already-finished upload into
		// a deletion; its ordinary receipt/expiry now owns the blob.
		if (!ticket || ticket.status !== 'uploading') return;
		if (args.storageId) await ctx.storage.delete(args.storageId);
		await ctx.db.delete(ticket._id);
	},
});

/** Bind once in the SAME transaction as the resource insert/update. */
export async function consumeUpload(
	ctx: MutationCtx,
	storageId: Id<'_storage'>,
	session: UploadSession,
	resourceKey: string
): Promise<Id<'storageUploads'>> {
	const receipt = await ctx.db
		.query('storageUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.unique();
	if (
		!receipt ||
		receipt.status !== 'uploaded' ||
		receipt.userId !== session.userId ||
		receipt.organizationId !== session.activeOrganizationId ||
		(receipt.expiresAt ?? 0) <= Date.now()
	) {
		throwForbidden('File is not an unclaimed upload owned by this user');
	}
	await ctx.db.patch(receipt._id, { status: 'bound', resourceKey, expiresAt: undefined });
	return receipt._id;
}

/** Legacy/inherited references remain readable but cannot authorize blob deletion. */
export async function deleteOwnedUpload(
	ctx: MutationCtx,
	storageId: Id<'_storage'>,
	resourceKey: string
): Promise<void> {
	const receipt = await ctx.db
		.query('storageUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.unique();
	if (!receipt || receipt.status !== 'bound' || receipt.resourceKey !== resourceKey) return;
	await ctx.storage.delete(storageId);
	await ctx.db.delete(receipt._id);
}

/** Move deletion authority with an attachment; legacy references grant no ownership. */
export async function transferOwnedUpload(
	ctx: MutationCtx,
	storageId: Id<'_storage'>,
	fromResource: string,
	toResource: string
): Promise<boolean> {
	const receipt = await ctx.db
		.query('storageUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.unique();
	if (!receipt || receipt.status !== 'bound' || receipt.resourceKey !== fromResource) return false;
	await ctx.db.patch(receipt._id, { resourceKey: toResource });
	return true;
}

/** Expiring abandoned tickets and unclaimed blobs never removes a bound resource. */
export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('storageUploads')
			.withIndex('by_expiry', (q) => q.gt('expiresAt', 0).lte('expiresAt', Date.now()))
			.take(200);
		for (const ticket of expired) {
			if (ticket.status === 'bound') continue;
			if (ticket.storageId) await ctx.storage.delete(ticket.storageId);
			await ctx.db.delete(ticket._id);
		}
	},
});
