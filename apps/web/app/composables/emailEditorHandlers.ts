import { ref } from 'vue';
import {
	provideEmailBuilderHandlers,
	type EditorBlock,
	type ImageUploadResult,
	type SavedBlock,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getImageDimensions } from '~/utils/getImageDimensions';
import { SurfacedOperationError } from '~/lib/operationError';
import type { BackendOperationResult } from './useBackendOperation';
import {
	registerUploadedMediaReference,
	type MediaAssetReferenceDeps,
} from '~/utils/mediaAssetReference';

/**
 * The EmailBuilder handlers the email editor bridge (useEmailEditorBridge.ts)
 * injects. The two factories are pure functions of their injected mutations,
 * so they are testable without mounting a page.
 */

// uploadImage pipeline: the four steps, the three error modes, and the
// media-library side effect.

export interface UploadImageDeps extends MediaAssetReferenceDeps {
	/** Mint a one-shot upload URL (Convex `storage.generateUploadUrl`). */
	generateUploadUrl: () => Promise<string | null | undefined>;
	/** Measure the image client-side for the media-library record. */
	getImageDimensions: (file: File) => Promise<{ width: number; height: number } | null>;
}

/**
 * Build the `uploadImage` handler the EmailBuilder injects:
 * `generateUploadUrl` → POST the file → measure dimensions → `mediaAssets.create`
 * → `storage.getUrl`. Every uploaded image is auto-registered to the media
 * library (the easy-to-miss side effect).
 */
export function createUploadImageHandler(
	deps: UploadImageDeps
): (file: File) => Promise<ImageUploadResult> {
	return async (file: File): Promise<ImageUploadResult> => {
		const uploadUrl = await deps.generateUploadUrl();
		if (!uploadUrl) {
			throw new Error('Failed to get upload URL');
		}

		const response = await fetch(uploadUrl, {
			method: 'POST',
			headers: { 'Content-Type': file.type },
			body: file,
		});

		if (!response.ok) {
			throw new Error('Failed to upload image');
		}

		const uploadResult = (await response.json()) as { storageId?: unknown };
		if (typeof uploadResult.storageId !== 'string' || uploadResult.storageId.length === 0) {
			throw new Error('Image upload did not return a storage ID');
		}
		const storageId = uploadResult.storageId as Id<'_storage'>;

		// Auto-save to media library FIRST: `storage.getUrl` only resolves blobs
		// backed by a `mediaAssets` row (cross-resource IDOR guard), so the asset
		// must exist before we can mint its URL.
		const dimensions = await deps.getImageDimensions(file);
		const registered = await registerUploadedMediaReference(deps, {
			storageId,
			filename: file.name,
			mimeType: file.type,
			fileSize: file.size,
			width: dimensions?.width,
			height: dimensions?.height,
		});
		if (!registered.ok && registered.reason === 'media-registration-failed') {
			throw new Error('Image upload did not create a media asset');
		}
		if (!registered.ok) {
			throw new Error('Failed to get image URL');
		}

		return registered.reference;
	};
}

/**
 * Build the `savedBlocks.save` handler from the `emailBlocks.blocks.create`
 * operation. The operation resolves `{ ok: false }` on failure (it never
 * throws), but the builder's contract is promise-shaped: it keeps its save
 * dialog open, name intact, only when the handler rejects. So a failed result
 * must become a rejection — marked as already surfaced, because the operation
 * module has toasted it.
 */
export function createSavedBlockSaveHandler(
	createEmailBlock: (args: {
		name: string;
		content: string;
	}) => Promise<BackendOperationResult<unknown>>
): (block: { name: string; content: EditorBlock[] }) => Promise<void> {
	return async (block) => {
		const created = await createEmailBlock({
			name: block.name,
			content: JSON.stringify(block.content),
		});
		if (!created.ok) throw new SurfacedOperationError('Saving the block failed');
	};
}

/**
 * Produce the EmailBuilderHandlers the builder injects (zero config: the part
 * that used to be copied across the editor pages) and the media-picker state
 * its "pick from library" opens.
 */
export function provideEmailEditorHandlers() {
	const { t } = useI18n();
	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.useEmailEditorBridge.getUploadUrlOperation'),
	});
	const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
		label: () => t('shared.useEmailEditorBridge.saveMediaAssetOperation'),
	});
	const { run: createEmailBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
		label: () => t('shared.useEmailEditorBridge.saveBlockOperation'),
	});

	// Media-picker plumbing.
	const showMediaPicker = ref(false);
	let mediaPickerCallback: ((result: ImageUploadResult) => void) | null = null;
	const onMediaPickerSelect = (result: ImageUploadResult) => {
		mediaPickerCallback?.(result);
		mediaPickerCallback = null;
		showMediaPicker.value = false;
	};

	provideEmailBuilderHandlers({
		uploadImage: createUploadImageHandler({
			generateUploadUrl: async () => {
				const minted = await generateUploadUrl({});
				return minted.ok ? minted.result : null;
			},
			getUrl: (storageId) => requireConvex().query(api.storage.getUrl, { storageId }),
			createMediaAsset: async (asset) => {
				const created = await createMediaAsset(asset);
				return created.ok ? created.result : undefined;
			},
			getImageDimensions,
		}),
		pickFromMediaLibrary: (onSelect) => {
			mediaPickerCallback = onSelect;
			showMediaPicker.value = true;
		},
		savedBlocks: {
			fetch: async (params) => {
				const result = await requireConvex().query(api.emailBlocks.blocks.list, {
					search: params?.search,
				});
				return (result ?? []) as SavedBlock[];
			},
			save: createSavedBlockSaveHandler(createEmailBlock),
		},
	});

	return { showMediaPicker, onMediaPickerSelect };
}
