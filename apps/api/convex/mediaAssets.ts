import { authedQuery, authedMutation } from './lib/authedFunctions';
import { internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import { requireOrgPermission } from './lib/sessionOrganization';
import { throwNotFound, throwInvalidState, throwInvalidInput } from './_utils/errors';
import { logError } from './lib/runtimeLog';
import { isExtensionAllowed, isMimeTypeAllowed, isExecutableExtension, detectDoubleExtension, mergePolicy, DEFAULT_FILE_POLICY } from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';

// The media library re-allows SVG on top of the scanner default (which
// excludes it as script-capable): uploads here come from authenticated org
// members, and assets are consumed as <img src> in emails/builder previews —
// a context in which browsers never execute SVG scripts. Recipients are not
// handed SVG as an openable attachment through this path.
const MEDIA_LIBRARY_POLICY = mergePolicy({
	allowedTypes: [...DEFAULT_FILE_POLICY.allowedTypes, 'image/svg+xml'],
	allowedExtensions: [...DEFAULT_FILE_POLICY.allowedExtensions, '.svg'],
});

/**
 * Build searchable text from filename, alt, and tags.
 */
function buildSearchableText(filename: string, alt?: string, tags?: string[]): string {
	const parts: string[] = [];
	// Split filename on common separators
	parts.push(...filename.replace(/\.[^.]+$/, '').split(/[-_.\s]+/));
	if (alt) parts.push(alt);
	if (tags) parts.push(...tags);
	return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * List media assets for the organization (paginated).
 * Supports full-text search and tag filtering.
 */
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		search: v.optional(v.string()),
		tag: v.optional(v.string()),
		mimeTypePrefixes: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const applyPostFilters = (results: PaginationResult<Doc<'mediaAssets'>>) => {
			let page = results.page;
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
				.withSearchIndex('search_media', (q) =>
					q.search('searchableText', args.search!)
				)
				.paginate(args.paginationOpts);

			return applyPostFilters(results);
		}

		// Default: list by creation date (newest first)
		const results = await ctx.db
			.query('mediaAssets')
			.order('desc')
			.paginate(args.paginationOpts);

		return applyPostFilters(results);
	},
});

/**
 * Get a single media asset by ID.
 */
export const get = authedQuery({
	args: { assetId: v.id('mediaAssets') },
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (!asset) {
			return null;
		}
		return asset;
	},
});

/**
 * Get total count and total bytes for the organization's media library. The
 * summed `fileSize` is the server-reconciled blob size (set by
 * `scanAssetBytes` → `reconcileAssetSize` shortly after upload), not the
 * client-supplied value, so the quota can't be gamed by an under-reported size.
 */
// Cap on the stats scan. The media library is operator-curated and bounded in
// practice; the cap keeps an unusually large library from blowing the per-query
// read budget. Totals saturate at the cap (matching contacts.getTimelineStats).
const MEDIA_SCAN_LIMIT = 20_000;

export const getStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		const assets = await ctx.db
			.query('mediaAssets')
			.take(MEDIA_SCAN_LIMIT);
		const totalBytes = assets.reduce((sum, a) => sum + a.fileSize, 0);
		return { totalCount: assets.length, totalBytes, truncated: assets.length >= MEDIA_SCAN_LIMIT };
	},
});

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
// all-members: read-only reference count for the media library, shown in the
// asset detail panel — same member-visible posture as list / getStats / get.
export const countUsage = authedQuery({
	args: { assetId: v.id('mediaAssets') },
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (!asset) return { count: 0 };
		const needle = String(asset.storageId);

		const [templates, transactional, blocks] = await Promise.all([
			ctx.db.query('emailTemplates').take(MEDIA_SCAN_LIMIT),
			ctx.db.query('transactionalEmails').take(MEDIA_SCAN_LIMIT),
			ctx.db.query('emailBlocks').take(MEDIA_SCAN_LIMIT),
		]);

		let count = 0;
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
	},
});

/**
 * Collect all unique tags from the organization's media library.
 */
export const listTags = authedQuery({
	args: {},
	handler: async (ctx) => {
		const assets = await ctx.db
			.query('mediaAssets')
			.take(MEDIA_SCAN_LIMIT);
		const tagSet = new Set<string>();
		for (const asset of assets) {
			if (asset.tags) {
				for (const tag of asset.tags) {
					tagSet.add(tag);
				}
			}
		}
		return [...tagSet].sort();
	},
});

/**
 * Create a new media asset record.
 */
export const create = authedMutation({
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		alt: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'media:manage', 'Only owners and admins can create media assets');

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

		// Enforce the per-file size ceiling. `scanAssetBytes` later reconciles
		// the real blob size against `fileSize` for quota purposes, but that only
		// catches under-reporting — it imposes no maximum, so the cap lives here.
		if (args.fileSize > MAX_LIBRARY_FILE_BYTES) {
			throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
		}

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
			fileSize: args.fileSize,
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

		// The above checks only trust the CLIENT-SUPPLIED filename/MIME. Verify
		// the ACTUAL stored bytes asynchronously: reading a blob requires an
		// action, so schedule a magic-byte scan that quarantines the asset if
		// its real signature is a disguised executable.
		await ctx.scheduler.runAfter(0, internal.mediaAssets.scanAssetBytes, {
			assetId,
			storageId: args.storageId,
		});

		return assetId;
	},
});

/**
 * A client that under-reports `fileSize` by more than this factor relative to
 * the real blob size is treated as a deliberate storage-quota evasion attempt
 * and the asset is quarantined rather than silently corrected. Honest rounding /
 * metadata-vs-bytes drift stays well under it. Server-measured `blob.size` is
 * always authoritative for the quota regardless.
 */
const FILE_SIZE_MISMATCH_QUARANTINE_FACTOR = 1.5;

/**
 * Internal: read a freshly-stored blob's magic bytes and (a) quarantine the
 * asset if its real signature is a known dangerous/executable type masquerading
 * as media (e.g. a PE/ELF binary uploaded as image/png — the client-supplied
 * filename + MIME can't be trusted), and (b) reconcile the persisted `fileSize`
 * against the real blob size so the storage quota (`getStats`) can never be
 * gamed by a client lying about how big its upload is.
 *
 * Conservative by design: a dangerous-signature hit (`isDangerousFileType`) or
 * a gross size under-report (> `FILE_SIZE_MISMATCH_QUARANTINE_FACTOR`)
 * quarantines; a minor mismatch is corrected in place. FAILS OPEN on any
 * read/scan error so a transient storage hiccup can never delete a legitimate
 * asset.
 */
export const scanAssetBytes = internalAction({
	args: {
		assetId: v.id('mediaAssets'),
		storageId: v.id('_storage'),
	},
	handler: async (ctx, args) => {
		let firstBytes: Uint8Array;
		let isoProbe: Uint8Array | undefined;
		let actualSize: number;
		try {
			const blob = await ctx.storage.get(args.storageId);
			if (!blob) return; // already deleted
			actualSize = blob.size;
			firstBytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
			// Probe the ISO 9660 descriptor at offset 0x8001 to catch renamed ISOs.
			if (blob.size >= 0x8006) {
				isoProbe = new Uint8Array(await blob.slice(0x8001, 0x8006).arrayBuffer());
			}
		} catch {
			return; // fail open — never delete on a read error
		}

		const { isDangerousFileType, detectFileType } = await import('@owlat/email-scanner/files');
		if (isDangerousFileType(firstBytes, isoProbe)) {
			const detected = detectFileType(firstBytes, isoProbe);
			await ctx.runMutation(internal.mediaAssets.quarantineAsset, {
				assetId: args.assetId,
				storageId: args.storageId,
				reason: detected?.description ?? 'dangerous file signature',
			});
			return;
		}

		// Reconcile the client-supplied fileSize against the real blob size.
		await ctx.runMutation(internal.mediaAssets.reconcileAssetSize, {
			assetId: args.assetId,
			storageId: args.storageId,
			actualSize,
		});
	},
});

/**
 * Internal: correct a media asset's stored `fileSize` to the server-measured
 * blob size. A gross under-report (the client claimed it was far smaller than it
 * is — a quota-evasion attempt) quarantines the asset instead. Server-measured
 * size is authoritative for the quota in every case.
 */
export const reconcileAssetSize = internalMutation({
	args: {
		assetId: v.id('mediaAssets'),
		storageId: v.id('_storage'),
		actualSize: v.number(),
	},
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (!asset) return; // already deleted / quarantined
		if (asset.fileSize === args.actualSize) return; // already accurate

		// Gross under-report → treat as quota evasion and quarantine.
		const claimed = asset.fileSize;
		const grossUnderReport =
			args.actualSize > claimed * FILE_SIZE_MISMATCH_QUARANTINE_FACTOR;
		if (grossUnderReport) {
			await ctx.db.delete(args.assetId);
			try {
				await ctx.storage.delete(args.storageId);
			} catch {
				// Blob may already be gone — best effort.
			}
			logError(
				`[mediaAssets] quarantined asset ${args.assetId} — fileSize under-reported: claimed ${claimed}, actual ${args.actualSize}`,
			);
			return;
		}

		await ctx.db.patch(args.assetId, {
			fileSize: args.actualSize,
			updatedAt: Date.now(),
		});
	},
});

/** Internal: delete a quarantined media asset record + its stored blob. */
export const quarantineAsset = internalMutation({
	args: {
		assetId: v.id('mediaAssets'),
		storageId: v.id('_storage'),
		reason: v.string(),
	},
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (asset) await ctx.db.delete(args.assetId);
		try {
			await ctx.storage.delete(args.storageId);
		} catch {
			// Blob may already be gone — best effort.
		}
		logError(`[mediaAssets] quarantined asset ${args.assetId} — ${args.reason}`);
	},
});

/**
 * Update a media asset's metadata (alt text, tags).
 */
export const update = authedMutation({
	args: {
		assetId: v.id('mediaAssets'),
		alt: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'media:manage', 'Only owners and admins can update media assets');
		const asset = await ctx.db.get(args.assetId);
		if (!asset) { throwNotFound('Media asset'); }

		const newAlt = args.alt !== undefined ? args.alt : asset.alt;
		const newTags = args.tags !== undefined ? args.tags : asset.tags;
		const searchableText = buildSearchableText(asset.filename, newAlt, newTags);

		await ctx.db.patch(args.assetId, {
			...(args.alt !== undefined && { alt: args.alt }),
			...(args.tags !== undefined && { tags: args.tags }),
			searchableText,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Delete a single media asset and its storage file.
 */
export const remove = authedMutation({
	args: { assetId: v.id('mediaAssets') },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'media:manage', 'Only owners and admins can delete media assets');
		const asset = await ctx.db.get(args.assetId);
		if (!asset) { throwNotFound('Media asset'); }

		await ctx.storage.delete(asset.storageId);
		await ctx.db.delete(args.assetId);
	},
});

/**
 * Bulk delete media assets.
 */
export const bulkDelete = authedMutation({
	args: { assetIds: v.array(v.id('mediaAssets')) },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'media:manage', 'Only owners and admins can bulk-delete media assets');

		for (const assetId of args.assetIds) {
			const asset = await ctx.db.get(assetId);
			if (!asset) continue;
			await ctx.storage.delete(asset.storageId);
			await ctx.db.delete(assetId);
		}
	},
});
