<script setup lang="ts">
/**
 * AttachmentPanel — Manages file attachments for transactional emails.
 *
 * Allows uploading files (any type), picking from media library,
 * and removing attachments. Files are uploaded to Convex storage
 * and registered in the media library.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';

export interface StoredAttachment {
	id: string;
	filename: string;
	storageId: string;
	url: string;
	contentType: string;
	fileSize: number;
	mediaAssetId?: string;
}

const props = defineProps<{
	attachments: StoredAttachment[];
}>();

const emit = defineEmits<{
	(e: 'update:attachments', value: StoredAttachment[]): void;
}>();

const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
	label: 'Get upload URL',
});
const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
	label: 'Save attachment',
});
const { showToast } = useToast();

const isUploading = ref(false);
const showMediaPicker = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDropZone((files) => {
	void handleFileUpload(files);
});

const MAX_ATTACHMENTS = ATTACHMENT_COMPOSE_LIMITS.maxCount;
const MAX_TOTAL_SIZE = ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes;

const totalSize = computed(() => props.attachments.reduce((sum, a) => sum + a.fileSize, 0));

const canAddMore = computed(
	() => props.attachments.length < MAX_ATTACHMENTS && totalSize.value < MAX_TOTAL_SIZE
);

const sizePercent = computed(() =>
	Math.min(100, Math.round((totalSize.value / MAX_TOTAL_SIZE) * 100))
);

function generateAttachmentId() {
	return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getFileIcon(contentType: string) {
	if (contentType.startsWith('image/')) return 'lucide:image';
	if (contentType === 'application/pdf') return 'lucide:file-text';
	if (
		contentType.includes('spreadsheet') ||
		contentType.includes('csv') ||
		contentType.includes('excel')
	)
		return 'lucide:table';
	if (contentType.includes('zip') || contentType.includes('compressed'))
		return 'lucide:file-archive';
	if (contentType.includes('word') || contentType.includes('document')) return 'lucide:file-text';
	return 'lucide:file';
}

function getFileExtColor(contentType: string) {
	if (contentType === 'application/pdf') return 'text-red-500 bg-red-500/10';
	if (contentType.startsWith('image/')) return 'text-violet-500 bg-violet-500/10';
	if (
		contentType.includes('spreadsheet') ||
		contentType.includes('csv') ||
		contentType.includes('excel')
	)
		return 'text-emerald-500 bg-emerald-500/10';
	if (contentType.includes('zip')) return 'text-amber-500 bg-amber-500/10';
	return 'text-text-secondary bg-bg-surface';
}

async function handleFileUpload(files: FileList | File[]) {
	const fileArray = Array.from(files);
	if (fileArray.length === 0) return;

	// Validate limits
	const remainingSlots = MAX_ATTACHMENTS - props.attachments.length;
	if (remainingSlots <= 0) {
		showToast(`Maximum ${MAX_ATTACHMENTS} attachments allowed`, 'error');
		return;
	}

	const filesToUpload = fileArray.slice(0, remainingSlots);
	let currentTotal = totalSize.value;

	isUploading.value = true;
	try {
		const newAttachments: StoredAttachment[] = [];

		for (const file of filesToUpload) {
			if (currentTotal + file.size > MAX_TOTAL_SIZE) {
				showToast(
					`Total size would exceed ${formatCompactFileSize(MAX_TOTAL_SIZE)} limit`,
					'error'
				);
				break;
			}

			const upload = await uploadFileToStorage(
				file,
				() => generateUploadUrl({}),
				file.type || 'application/octet-stream'
			);
			if (!upload.ok) {
				if (upload.reason === 'upload-failed') showToast(`Failed to upload ${file.name}`, 'error');
				break;
			}
			const storageId = upload.storageId;

			// Register in media library FIRST: `storage.getUrl` only resolves blobs
			// backed by a `mediaAssets` row (cross-resource IDOR guard), so the
			// asset must exist before we can mint its URL.
			const created = await createMediaAsset({
				storageId,
				filename: file.name,
				mimeType: file.type || 'application/octet-stream',
				fileSize: file.size,
			});
			if (created === undefined) break;

			const url = await requireConvex().query(api.storage.getUrl, { storageId });
			if (!url) {
				showToast('Failed to get file URL', 'error');
				break;
			}

			newAttachments.push({
				id: generateAttachmentId(),
				filename: file.name,
				storageId,
				url,
				contentType: file.type || 'application/octet-stream',
				fileSize: file.size,
			});

			currentTotal += file.size;
		}

		if (newAttachments.length > 0) {
			emit('update:attachments', [...props.attachments, ...newAttachments]);
		}
	} finally {
		isUploading.value = false;
	}
}

function handleMediaPickerSelect(result: {
	url: string;
	storageId?: string;
	filename?: string;
	contentType?: string;
	fileSize?: number;
}) {
	if (!result.storageId || !result.url) return;

	const fileSize = result.fileSize ?? 0;
	if (totalSize.value + fileSize > MAX_TOTAL_SIZE) {
		showToast(`Total size would exceed ${formatCompactFileSize(MAX_TOTAL_SIZE)} limit`, 'error');
		return;
	}

	if (props.attachments.length >= MAX_ATTACHMENTS) {
		showToast(`Maximum ${MAX_ATTACHMENTS} attachments allowed`, 'error');
		return;
	}

	const attachment: StoredAttachment = {
		id: generateAttachmentId(),
		filename: result.filename ?? 'file',
		storageId: result.storageId,
		url: result.url,
		contentType: result.contentType ?? 'application/octet-stream',
		fileSize,
	};

	emit('update:attachments', [...props.attachments, attachment]);
	showMediaPicker.value = false;
}

function removeAttachment(id: string) {
	emit(
		'update:attachments',
		props.attachments.filter((a) => a.id !== id)
	);
}

function handleFileInput(event: Event) {
	const input = event.target as HTMLInputElement;
	if (input.files?.length) {
		handleFileUpload(input.files);
		input.value = '';
	}
}
</script>

<template>
	<div>
		<!-- Drop zone — always visible -->
		<div
			class="relative rounded-xl border-2 border-dashed transition-all duration-(--motion-moderate) cursor-pointer"
			:class="
				isDragOver
					? 'border-brand bg-brand/5'
					: attachments.length > 0
						? 'border-border-subtle bg-bg-base'
						: 'border-border-subtle hover:border-border-strong hover:bg-bg-surface/30'
			"
			@dragover="handleDragOver"
			@dragleave="handleDragLeave"
			@drop="handleDrop"
		>
			<!-- Attachment list (when files exist) -->
			<div v-if="attachments.length > 0" class="p-3 space-y-1.5">
				<div
					v-for="att in attachments"
					:key="att.id"
					class="group flex items-center gap-2.5 px-3 py-2 rounded-lg bg-bg-surface/60 hover:bg-bg-surface transition-colors"
				>
					<div
						class="flex items-center justify-center w-7 h-7 rounded-md shrink-0"
						:class="getFileExtColor(att.contentType)"
					>
						<Icon :name="getFileIcon(att.contentType)" class="w-3.5 h-3.5" />
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-[13px] text-text-primary truncate leading-tight">{{ att.filename }}</p>
						<p class="text-[11px] text-text-tertiary leading-tight">
							{{ formatCompactFileSize(att.fileSize) }}
						</p>
					</div>
					<button
						class="shrink-0 p-1 rounded-md text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error/10 transition-all"
						title="Remove attachment"
						@click.stop="removeAttachment(att.id)"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>

				<!-- Size meter -->
				<div class="flex items-center gap-3 px-1 pt-1">
					<UiProgressBar
						class="flex-1"
						size="sm"
						:value="sizePercent"
						:variant="sizePercent > 80 ? 'warning' : 'brand'"
						aria-label="Total attachment size used"
					/>
					<span class="text-[10px] text-text-tertiary shrink-0">
						{{ formatCompactFileSize(totalSize) }} / {{ formatCompactFileSize(MAX_TOTAL_SIZE) }}
					</span>
				</div>
			</div>

			<!-- Add more / empty state drop zone -->
			<div
				v-if="canAddMore"
				class="flex items-center justify-center gap-3 px-4"
				:class="attachments.length > 0 ? 'pb-3 pt-1' : 'py-5'"
				@click="fileInputRef?.click()"
			>
				<Icon v-if="isUploading" name="lucide:loader-2" class="w-4 h-4 text-brand animate-spin" />
				<template v-else>
					<Icon name="lucide:paperclip" class="w-4 h-4 text-text-tertiary" />
					<span class="text-sm text-text-secondary">
						{{
							attachments.length > 0
								? 'Drop more files or click to add'
								: 'Drop files here to attach, or click to browse'
						}}
					</span>
				</template>
				<span class="text-text-tertiary mx-1">|</span>
				<button
					class="text-sm text-text-secondary hover:text-brand transition-colors"
					@click.stop="showMediaPicker = true"
				>
					Media library
				</button>
			</div>

			<!-- Limit reached -->
			<div v-if="!canAddMore && attachments.length > 0" class="px-4 pb-3 pt-1 text-center">
				<span class="text-[11px] text-text-tertiary">
					{{ attachments.length >= MAX_ATTACHMENTS ? 'Max files reached' : 'Size limit reached' }}
				</span>
			</div>
		</div>

		<input ref="fileInputRef" type="file" class="hidden" multiple @change="handleFileInput" />

		<!-- Media Picker Modal -->
		<MediaPickerModal
			:open="showMediaPicker"
			title="Select Attachment"
			:allow-all-files="true"
			@update:open="showMediaPicker = $event"
			@select="handleMediaPickerSelect"
		/>
	</div>
</template>
