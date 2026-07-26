import type { Id } from '@owlat/api/dataModel';

export interface UploadedMediaMetadata {
	storageId: Id<'_storage'>;
	filename: string;
	mimeType: string;
	fileSize: number;
	width?: number;
	height?: number;
}

export interface StoredMediaReference {
	url: string;
	storageId: Id<'_storage'>;
	mediaAssetId: Id<'mediaAssets'>;
}

export interface MediaAssetReferenceDeps {
	createMediaAsset: (metadata: UploadedMediaMetadata) => Promise<Id<'mediaAssets'> | undefined>;
	getUrl: (storageId: Id<'_storage'>) => Promise<string | null>;
}

export type MediaAssetReferenceResult =
	| { ok: true; reference: StoredMediaReference }
	| { ok: false; reason: 'media-registration-failed' | 'url-unavailable' };

/**
 * Register an already-uploaded blob before resolving its guarded capability URL.
 */
export async function registerUploadedMediaReference(
	deps: MediaAssetReferenceDeps,
	metadata: UploadedMediaMetadata
): Promise<MediaAssetReferenceResult> {
	const mediaAssetId = await deps.createMediaAsset(metadata);
	if (!mediaAssetId) return { ok: false, reason: 'media-registration-failed' };

	const url = await deps.getUrl(metadata.storageId);
	if (!url) return { ok: false, reason: 'url-unavailable' };

	return {
		ok: true,
		reference: { url, storageId: metadata.storageId, mediaAssetId },
	};
}
