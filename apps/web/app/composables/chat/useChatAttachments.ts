import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Upload a file as a chat attachment.
 *
 * Three-step flow: generate signed URL → PUT blob → register the storageId
 * as a mediaAssets row. Returns the mediaAssets id, which the caller passes
 * to `chat.messages.sendMessage` via `attachmentIds`.
 */
export function useChatAttachments() {
	const { run: generateUploadUrlMutation } = useBackendOperation(
		api.chat.attachments.generateUploadUrl,
		{ label: 'Prepare attachment upload' },
	);
	const { run: registerAttachmentMutation } = useBackendOperation(
		api.chat.attachments.registerAttachment,
		{ label: 'Register attachment' },
	);

	const isUploading = ref(false);

	const uploadFile = async (file: File): Promise<Id<'mediaAssets'> | null> => {
		isUploading.value = true;
		try {
			// Raw blob POST — not a backend operation, so it isn't covered by the
			// operation module. A transport failure here just aborts this upload.
			let storageId: Id<'_storage'>;
			try {
				const upload = await uploadFileToStorage(
					file,
					() => generateUploadUrlMutation({}),
					file.type || 'application/octet-stream',
				);
				if (!upload.ok) return null;
				storageId = upload.storageId;
			} catch {
				return null;
			}

			// Probe image dimensions client-side so the message renderer can
			// reserve correct space (skips for non-image MIME types).
			let width: number | undefined;
			let height: number | undefined;
			if (file.type.startsWith('image/')) {
				const probed = await probeImageDimensions(file);
				width = probed.width;
				height = probed.height;
			}

			const assetId = await registerAttachmentMutation({
				storageId,
				filename: file.name,
				mimeType: file.type || 'application/octet-stream',
				fileSize: file.size,
				width,
				height,
			});
			return assetId ?? null;
		} finally {
			isUploading.value = false;
		}
	};

	return { uploadFile, isUploading };
}

/**
 * Hydrate a message's attachments into URL + dimensions for inline render.
 *
 * Keyed by `messageId` (not raw asset ids) so the backend can authorize access
 * via the message's room membership. Pass `null` to skip (e.g. messages with no
 * attachments).
 */
export function useChatAttachmentDetails(messageIdRef: () => Id<'chatMessages'> | null) {
	const { data, isLoading } = useConvexQuery(
		api.chat.attachments.getAttachmentDetails,
		() => {
			const messageId = messageIdRef();
			if (!messageId) return 'skip';
			return { messageId };
		},
	);
	const attachments = computed(() => data.value ?? []);
	return { attachments, isLoading };
}

async function probeImageDimensions(file: File): Promise<{ width?: number; height?: number }> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve({});
		};
		img.src = url;
	});
}
