/**
 * The shared media library: its reads, uploads, metadata edits and deletes.
 * The byte scan each upload schedules is in `mediaAssetScan.ts`.
 */
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { v, type ObjectType } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import { getInstanceSettings } from '../lib/instanceSettings';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidState, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { isChatAttachment, assertUnregisteredMediaStorage } from '../chat/attachmentAccess';
import { consumeUpload, deleteOwnedUpload, storedFileSize } from '../storage/uploads';
import { MEDIA_LIBRARY_POLICY, buildSearchableText } from '../lib/mediaLibraryPolicy';
import {
	isExtensionAllowed,
	isMimeTypeAllowed,
	isExecutableExtension,
	detectDoubleExtension,
} from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';

/** `list`'s arguments. */
export const listArgs = {
	paginationOpts: paginationOptsValidator,
	search: v.optional(v.string()),
	tag: v.optional(v.string()),
	mimeTypePrefixes: v.optional(v.array(v.string())),
};

/**
 * List media assets for the organization (paginated).
 * Supports full-text search and tag filtering.
 */
export async function listMediaAssets(ctx: QueryCtx, args: ObjectType<typeof listArgs>) {
	const applyPostFilters = (results: PaginationResult<Doc<'mediaAssets'>>) => {
		// Chat files share the table, but their room owns the read boundary.
		let page = results.page.filter((asset) => !isChatAttachment(asset));
		if (args.tag) {
			page = page.filter((a) => a.tags?.includes(args.tag!));
		}
		if (args.mimeTypePrefixes && args.mimeTypePrefixes.length > 0) {
			page = page.filter((a) =>
				args.mimeTypePrefixes!.some((prefix) => a.mimeType?.startsWith(prefix))
			);
		}
		return page === results.page ? results : { ...results, page };
	};

	if (args.search && args.search.trim()) {
		// Use search index for text search
		const results = await ctx.db
			.query('mediaAssets')
			.withSearchIndex('search_media', (q) => q.search('searchableText', args.search!))
			.paginate(args.paginationOpts);

		return applyPostFilters(results);
	}

	// Default: list by creation date (newest first)
	const results = await ctx.db.query('mediaAssets').order('desc').paginate(args.paginationOpts);

	return applyPostFilters(results);
}

// all-members: the shared media library every role uses in the email editor;
// chat attachments are dropped (their room owns that read), and writing the
// library needs media:manage.
export const list = authedQuery({
	args: listArgs,
	handler: async (ctx, args) => await listMediaAssets(ctx, args),
});

// Cap on the stats scan. The media library is operator-curated and bounded in
// practice; the cap keeps an unusually large library from blowing the per-query
// read budget. Totals saturate at the cap (matching contacts.getTimelineStats).
const MEDIA_SCAN_LIMIT = 20_000;

/**
 * Get total count and total bytes for the organization's media library. The
 * summed `fileSize` is the server-reconciled blob size (set by
 * `scanAssetBytes` → `reconcileAssetSize` shortly after upload), not the
 * client-supplied value, so the quota can't be gamed by an under-reported size.
 */
export async function mediaLibraryStats(ctx: QueryCtx) {
	const assets = await ctx.db.query('mediaAssets').take(MEDIA_SCAN_LIMIT);
	const sharedAssets = assets.filter((asset) => !isChatAttachment(asset));
	const totalBytes = sharedAssets.reduce((sum, a) => sum + a.fileSize, 0);
	return {
		totalCount: sharedAssets.length,
		totalBytes,
		truncated: assets.length >= MEDIA_SCAN_LIMIT,
	};
}

// all-members: count and size of the shared library, chat attachments left out.
export const getStats = authedQuery({
	args: {},
	handler: async (ctx) => await mediaLibraryStats(ctx),
});

/** `countUsage`'s arguments. */
export const countUsageArgs = { assetId: v.id('mediaAssets') };

/**
 * Count how many email templates, transactional emails and saved blocks
 * reference a media asset (the per-asset "usage" figure shown in the library
 * detail panel).
 *
 * Library images are inserted with the asset's `storageId` recorded in the
 * editor `content` JSON (the media picker sets `ImageBlockContent.storageId`),
 * so a substring match on the unique `_storage` id is an exact, false-positive-
 * free signal — the id is opaque and appears nowhere else. The same picker +
 * editor bridge feeds the saved-block editor, so `emailBlocks.content` carries
 * the identical signal and is scanned too. Bounded by `MEDIA_SCAN_LIMIT` for
 * the same reason `getStats` is: the template set is operator-curated, and the
 * cap keeps an outsized library from blowing the per-query read budget.
 */
export async function countAssetUsage(ctx: QueryCtx, assetId: Id<'mediaAssets'>) {
	const asset = await ctx.db.get(assetId);
	if (!asset || isChatAttachment(asset)) return { count: 0 };
	const needle = asset.storageId;

	const [templates, transactional, blocks] = await Promise.all([
		ctx.db.query('emailTemplates').take(MEDIA_SCAN_LIMIT),
		ctx.db.query('transactionalEmails').take(MEDIA_SCAN_LIMIT),
		ctx.db.query('emailBlocks').take(MEDIA_SCAN_LIMIT),
	]);

	// The brand kit's logo is a use too: deleting it takes the logo out of
	// every new email.
	const brandKit = (await getInstanceSettings(ctx.db))?.brandKit;
	let count =
		brandKit?.logoMediaAssetId === asset._id || brandKit?.logoDarkMediaAssetId === asset._id
			? 1
			: 0;
	for (const t of templates) {
		if (t.content.includes(needle)) count++;
	}
	for (const e of transactional) {
		if (e.content.includes(needle)) count++;
	}
	for (const b of blocks) {
		if (b.content.includes(needle)) count++;
	}
	return { count };
}

// all-members: read-only reference count for the media library, shown in the
// asset detail panel — same member-visible posture as list / getStats / get.
export const countUsage = authedQuery({
	args: countUsageArgs,
	handler: async (ctx, args) => await countAssetUsage(ctx, args.assetId),
});

/** Collect all unique tags from the organization's media library. */
export async function listMediaTags(ctx: QueryCtx) {
	const assets = await ctx.db.query('mediaAssets').take(MEDIA_SCAN_LIMIT);
	const tagSet = new Set<string>();
	for (const asset of assets) {
		if (isChatAttachment(asset)) continue;
		if (asset.tags) {
			for (const tag of asset.tags) {
				tagSet.add(tag);
			}
		}
	}
	return [...tagSet].sort();
}

// all-members: the tag filter of the shared library, chat attachments left out.
export const listTags = authedQuery({
	args: {},
	handler: async (ctx) => await listMediaTags(ctx),
});

/** `create`'s arguments. */
export const createArgs = {
	storageId: v.id('_storage'),
	filename: v.string(),
	mimeType: v.string(),
	fileSize: v.number(),
	width: v.optional(v.number()),
	height: v.optional(v.number()),
	alt: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
};

/** Create a new media asset record. Requires media:manage before it writes. */
export async function createMediaAsset(
	ctx: MutationCtx,
	args: ObjectType<typeof createArgs>,
	session: MutationSessionContext
): Promise<Id<'mediaAssets'>> {
	validateStringLength(args.filename, STRING_LIMITS.FILENAME, 'filename');
	validateStringLength(args.mimeType, STRING_LIMITS.MIME_TYPE, 'mimeType');
	if (args.alt !== undefined) validateStringLength(args.alt, STRING_LIMITS.DESCRIPTION, 'alt');
	for (const tag of args.tags ?? []) validateStringLength(tag, STRING_LIMITS.TAG, 'Tag');

	requirePermission(
		hasPermission(session.role, 'media:manage'),
		'Only owners and admins can create media assets'
	);

	// Security: Validate file type before creating asset record
	const doubleExt = detectDoubleExtension(args.filename);
	if (doubleExt.detected && doubleExt.executableExtension) {
		throwInvalidInput(`File rejected: ${doubleExt.description}`);
	}

	if (isExecutableExtension(args.filename)) {
		throwInvalidInput(`Executable files are not allowed: ${args.filename}`);
	}

	if (!isExtensionAllowed(args.filename, MEDIA_LIBRARY_POLICY)) {
		throwInvalidInput(`File type not allowed: ${args.filename}`);
	}

	if (!isMimeTypeAllowed(args.mimeType, MEDIA_LIBRARY_POLICY)) {
		throwInvalidInput(`MIME type not allowed: ${args.mimeType}`);
	}

	// Admit and account using immutable storage metadata before scheduling
	// any scanner work; the browser's byte count is only an untrusted hint.
	const fileSize = await storedFileSize(ctx, args.storageId);
	if (fileSize <= 0) throwInvalidInput('File size must be positive');
	if (fileSize > MAX_LIBRARY_FILE_BYTES) {
		throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
	}

	await assertUnregisteredMediaStorage(ctx, args.storageId);
	const url = await ctx.storage.getUrl(args.storageId);
	if (!url) {
		throwInvalidState('Failed to resolve storage URL');
	}

	const now = Date.now();
	const searchableText = buildSearchableText(args.filename, args.alt, args.tags);

	const assetId = await ctx.db.insert('mediaAssets', {
		storageId: args.storageId,
		filename: args.filename,
		mimeType: args.mimeType,
		fileSize,
		width: args.width,
		height: args.height,
		url,
		alt: args.alt,
		tags: args.tags,
		uploadedBy: session.userId,
		searchableText,
		createdAt: now,
		updatedAt: now,
	});
	await consumeUpload(ctx, args.storageId, session, `mediaAssets:${assetId}`);

	// The above checks only trust the CLIENT-SUPPLIED filename/MIME. Verify
	// the ACTUAL stored bytes asynchronously: reading a blob requires an
	// action, so schedule a magic-byte scan that quarantines the asset if
	// its real signature is a disguised executable.
	await ctx.scheduler.runAfter(0, internal.workspaces.mediaAssetScan.scanAssetBytes, {
		assetId,
		storageId: args.storageId,
	});

	return assetId;
}

// authz: createMediaAsset requires media:manage before it writes.
export const create = authedMutation({
	args: createArgs,
	handler: async (ctx, args, session) => await createMediaAsset(ctx, args, session),
});

/** `update`'s arguments. */
export const updateArgs = {
	assetId: v.id('mediaAssets'),
	alt: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
};

/**
 * Update a media asset's metadata (alt text, tags). Requires media:manage
 * before it reads or writes.
 */
export async function updateMediaAsset(
	ctx: MutationCtx,
	args: ObjectType<typeof updateArgs>,
	session: MutationSessionContext
): Promise<void> {
	if (args.alt !== undefined) validateStringLength(args.alt, STRING_LIMITS.DESCRIPTION, 'alt');
	for (const tag of args.tags ?? []) validateStringLength(tag, STRING_LIMITS.TAG, 'Tag');

	requirePermission(
		hasPermission(session.role, 'media:manage'),
		'Only owners and admins can update media assets'
	);
	const asset = await getOrThrow(ctx, args.assetId, 'Media asset');
	if (isChatAttachment(asset)) throwNotFound('Media asset');

	const newAlt = args.alt !== undefined ? args.alt : asset.alt;
	const newTags = args.tags !== undefined ? args.tags : asset.tags;
	const searchableText = buildSearchableText(asset.filename, newAlt, newTags);

	await ctx.db.patch(args.assetId, {
		...(args.alt !== undefined && { alt: args.alt }),
		...(args.tags !== undefined && { tags: args.tags }),
		searchableText,
		updatedAt: Date.now(),
	});
}

// authz: updateMediaAsset requires media:manage before it reads or writes.
export const update = authedMutation({
	args: updateArgs,
	handler: async (ctx, args, session) => await updateMediaAsset(ctx, args, session),
});

/** `bulkDelete`'s arguments. */
export const bulkDeleteArgs = { assetIds: v.array(v.id('mediaAssets')) };

/** Bulk delete media assets. Requires media:manage before it reads or writes. */
export async function bulkDeleteMediaAssets(
	ctx: MutationCtx,
	assetIds: Id<'mediaAssets'>[],
	session: MutationSessionContext
): Promise<void> {
	requirePermission(
		hasPermission(session.role, 'media:manage'),
		'Only owners and admins can bulk-delete media assets'
	);

	for (const assetId of assetIds) {
		const asset = await ctx.db.get(assetId);
		if (!asset) continue;
		if (isChatAttachment(asset)) throwNotFound('Media asset');
		await deleteOwnedUpload(ctx, asset.storageId, `mediaAssets:${assetId}`);
		await ctx.db.delete(assetId);
	}
}

// authz: bulkDeleteMediaAssets requires media:manage before it reads or writes.
export const bulkDelete = authedMutation({
	args: bulkDeleteArgs,
	handler: async (ctx, args, session) => await bulkDeleteMediaAssets(ctx, args.assetIds, session),
});
