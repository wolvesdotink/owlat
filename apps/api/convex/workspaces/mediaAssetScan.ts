/**
 * The check a media library upload gets once its bytes are stored: the
 * client-supplied filename, MIME type and size are only hints, so a scan reads
 * the real blob and quarantines or corrects the asset.
 */
import { internalAction, type ActionCtx, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { v, type ObjectType } from 'convex/values';
import { deleteOwnedUpload } from '../storage/uploads';
import { logError } from '../lib/runtimeLog';
import { detectFileType, isDangerousFileType } from '@owlat/email-scanner';

/**
 * A client that under-reports `fileSize` by more than this factor relative to
 * the real blob size is treated as a deliberate storage-quota evasion attempt
 * and the asset is quarantined rather than silently corrected. Honest rounding /
 * metadata-vs-bytes drift stays well under it. Server-measured `blob.size` is
 * always authoritative for the quota regardless.
 */
const FILE_SIZE_MISMATCH_QUARANTINE_FACTOR = 1.5;

/** `scanAssetBytes`'s arguments. */
export const scanAssetBytesArgs = {
	assetId: v.id('mediaAssets'),
	storageId: v.id('_storage'),
};

/**
 * Read a freshly-stored blob's magic bytes and (a) quarantine the asset if its
 * real signature is a known dangerous/executable type masquerading as media
 * (e.g. a PE/ELF binary uploaded as image/png — the client-supplied filename +
 * MIME can't be trusted), and (b) reconcile the persisted `fileSize` against
 * the real blob size so the storage quota (`getStats`) can never be gamed by a
 * client lying about how big its upload is.
 *
 * Conservative by design: a dangerous-signature hit (`isDangerousFileType`) or
 * a gross size under-report (> `FILE_SIZE_MISMATCH_QUARANTINE_FACTOR`)
 * quarantines; a minor mismatch is corrected in place. FAILS OPEN on any
 * read/scan error so a transient storage hiccup can never delete a legitimate
 * asset.
 */
export async function scanStoredAssetBytes(
	ctx: ActionCtx,
	args: ObjectType<typeof scanAssetBytesArgs>
): Promise<void> {
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

	if (isDangerousFileType(firstBytes, isoProbe)) {
		const detected = detectFileType(firstBytes, isoProbe);
		await ctx.runMutation(internal.workspaces.mediaAssetScan.quarantineAsset, {
			assetId: args.assetId,
			storageId: args.storageId,
			reason: detected?.description ?? 'dangerous file signature',
		});
		return;
	}

	// Reconcile the client-supplied fileSize against the real blob size.
	await ctx.runMutation(internal.workspaces.mediaAssetScan.reconcileAssetSize, {
		assetId: args.assetId,
		storageId: args.storageId,
		actualSize,
	});
}

export const scanAssetBytes = internalAction({
	args: scanAssetBytesArgs,
	handler: async (ctx, args) => await scanStoredAssetBytes(ctx, args),
});

/** `reconcileAssetSize`'s arguments. */
export const reconcileAssetSizeArgs = {
	assetId: v.id('mediaAssets'),
	storageId: v.id('_storage'),
	actualSize: v.number(),
};

/**
 * Correct a media asset's stored `fileSize` to the server-measured blob size.
 * A gross under-report (the client claimed it was far smaller than it is — a
 * quota-evasion attempt) quarantines the asset instead. Server-measured size is
 * authoritative for the quota in every case.
 */
export async function reconcileStoredAssetSize(
	ctx: MutationCtx,
	args: ObjectType<typeof reconcileAssetSizeArgs>
): Promise<void> {
	const asset = await ctx.db.get(args.assetId);
	if (!asset) return; // already deleted / quarantined
	if (asset.fileSize === args.actualSize) return; // already accurate

	// Gross under-report → treat as quota evasion and quarantine.
	const claimed = asset.fileSize;
	const grossUnderReport = args.actualSize > claimed * FILE_SIZE_MISMATCH_QUARANTINE_FACTOR;
	if (grossUnderReport) {
		await ctx.db.delete(args.assetId);
		try {
			await deleteOwnedUpload(ctx, args.storageId, `mediaAssets:${args.assetId}`);
		} catch {
			// Blob may already be gone — best effort.
		}
		logError(
			`[mediaAssets] quarantined asset ${args.assetId} — fileSize under-reported: claimed ${claimed}, actual ${args.actualSize}`
		);
		return;
	}

	await ctx.db.patch(args.assetId, {
		fileSize: args.actualSize,
		updatedAt: Date.now(),
	});
}

export const reconcileAssetSize = internalMutation({
	args: reconcileAssetSizeArgs,
	handler: async (ctx, args) => await reconcileStoredAssetSize(ctx, args),
});

/** `quarantineAsset`'s arguments. */
export const quarantineAssetArgs = {
	assetId: v.id('mediaAssets'),
	storageId: v.id('_storage'),
	reason: v.string(),
};

/** Delete a quarantined media asset record + its stored blob. */
export async function quarantineStoredAsset(
	ctx: MutationCtx,
	args: ObjectType<typeof quarantineAssetArgs>
): Promise<void> {
	const asset = await ctx.db.get(args.assetId);
	if (asset) await ctx.db.delete(args.assetId);
	try {
		await deleteOwnedUpload(ctx, args.storageId, `mediaAssets:${args.assetId}`);
	} catch {
		// Blob may already be gone — best effort.
	}
	logError(`[mediaAssets] quarantined asset ${args.assetId} — ${args.reason}`);
}

export const quarantineAsset = internalMutation({
	args: quarantineAssetArgs,
	handler: async (ctx, args) => await quarantineStoredAsset(ctx, args),
});
