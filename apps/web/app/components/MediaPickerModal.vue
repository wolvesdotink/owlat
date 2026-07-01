<script setup lang="ts">
import { api } from '@owlat/api';
import { getImageDimensions } from '~/utils/getImageDimensions';

const props = withDefaults(defineProps<{
	open: boolean;
	/** Title override for the modal */
	title?: string;
	/** Accepted file types. Default: images only */
	accept?: string;
	/** Whether to allow any file type (overrides accept) */
	allowAllFiles?: boolean;
}>(), {
	title: 'Select Image',
	accept: 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml',
	allowAllFiles: false,
});

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'select', value: { url: string; storageId?: string; width?: number; height?: number; filename?: string; contentType?: string; fileSize?: number }): void;
}>();

const resolvedAccept = computed(() => props.allowAllFiles ? '*/*' : props.accept);

// Debounced so each keystroke doesn't re-subscribe the paginated query.
const { searchQuery, debouncedSearch } = useDebouncedSearch(300);
const activeTab = ref<'library' | 'upload'>('library');

const PAGE_SIZE = 20;
const {
	results: assets,
	status,
	loadMore,
	isLoading,
} = usePaginatedQuery(
	api.mediaAssets.list,
	() => ({
		search: debouncedSearch.value || undefined,
		mimeTypePrefixes: props.allowAllFiles ? undefined : ['image/'],
	}),
	{ initialNumItems: PAGE_SIZE }
);

// mimeTypePrefixes is a POST-pagination filter, so an image-only picker can get
// a page that's all non-image attachments and render "No media found" while
// images exist on later pages. Auto-load further pages until the grid fills or
// the list is exhausted (capped so a sparse match can't scan the whole table).
const MAX_AUTO_LOADS = 8;
let autoLoadCount = 0;
watch([() => assets.value.length, status], () => {
	if (
		!props.allowAllFiles &&
		status.value === 'CanLoadMore' &&
		assets.value.length < PAGE_SIZE &&
		autoLoadCount < MAX_AUTO_LOADS
	) {
		autoLoadCount += 1;
		loadMore(PAGE_SIZE);
	}
});
watch(debouncedSearch, () => {
	autoLoadCount = 0;
});

// Upload
const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
	label: 'Get upload URL',
});
const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
	label: 'Upload media',
});
const isUploading = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDropZone((files) => {
	void handleUploadAndSelect(files);
});

const selectAsset = (asset: (typeof assets.value)[0]) => {
	emit('select', {
		url: asset.url,
		storageId: asset.storageId as string,
		width: asset.width,
		height: asset.height,
		filename: asset.filename,
		contentType: asset.mimeType,
		fileSize: asset.fileSize,
	});
	emit('update:open', false);
};

const handleUploadAndSelect = async (files: File[]) => {
	if (files.length === 0) return;
	isUploading.value = true;
	try {
		const file = files[0]!;
		const upload = await uploadFileToStorage(file, () => generateUploadUrl({}));
		if (!upload.ok) {
			if (upload.reason === 'upload-failed') throw new Error('Upload failed');
			return;
		}
		const storageId = upload.storageId;
		const isImage = file.type.startsWith('image/');
		const dimensions = isImage ? await getImageDimensions(file) : null;

		const created = await createMediaAsset({
			storageId,
			filename: file.name,
			mimeType: file.type,
			fileSize: file.size,
			width: dimensions?.width,
			height: dimensions?.height,
		});
		if (created === undefined) return;

		// Get the URL and select it
		const url = await requireConvex().query(api.storage.getUrl, { storageId });
		if (url) {
			emit('select', {
				url,
				storageId,
				width: dimensions?.width,
				height: dimensions?.height,
				filename: file.name,
				contentType: file.type,
				fileSize: file.size,
			});
			emit('update:open', false);
		}
	} finally {
		isUploading.value = false;
	}
};

const handleFileInput = (event: Event) => {
	const input = event.target as HTMLInputElement;
	if (input.files?.length) {
		handleUploadAndSelect(Array.from(input.files));
		input.value = '';
	}
};


const getFileIcon = (mimeType: string) => {
	if (mimeType === 'application/pdf') return 'lucide:file-text';
	if (mimeType.startsWith('video/')) return 'lucide:film';
	if (mimeType.startsWith('audio/')) return 'lucide:music';
	return 'lucide:file';
};

</script>

<template>
	<UiModal :open="open" :title="title" size="xl" :z-index="10001" @update:open="emit('update:open', $event)">
		<!-- Tabs -->
		<div class="flex border-b border-border-subtle mb-4">
			<button
				class="px-4 py-2 text-sm font-medium transition-colors"
				:class="activeTab === 'library' ? 'text-brand border-b-2 border-brand' : 'text-text-secondary hover:text-text-primary'"
				@click="activeTab = 'library'"
			>
				Library
			</button>
			<button
				class="px-4 py-2 text-sm font-medium transition-colors"
				:class="activeTab === 'upload' ? 'text-brand border-b-2 border-brand' : 'text-text-secondary hover:text-text-primary'"
				@click="activeTab = 'upload'"
			>
				Upload
			</button>
		</div>

		<!-- Library tab -->
		<div v-if="activeTab === 'library'">
			<!-- Search -->
			<div class="mb-4">
				<UiInput v-model="searchQuery" placeholder="Search media..." />
			</div>

			<!-- Loading -->
			<div v-if="isLoading && assets.length === 0" class="flex items-center justify-center py-12">
				<UiSpinner size="md" />
			</div>

			<!-- Empty -->
			<div v-else-if="assets.length === 0" class="text-center py-12 text-text-secondary text-sm">
				{{ searchQuery ? 'No media found.' : 'No media uploaded yet. Switch to Upload tab.' }}
			</div>

			<!-- Grid -->
			<div v-else class="grid grid-cols-3 sm:grid-cols-4 gap-3 max-h-[400px] overflow-y-auto">
				<button
					v-for="asset in assets"
					:key="asset._id"
					class="group relative aspect-square bg-checker border border-border-subtle rounded-lg overflow-hidden cursor-pointer transition-all hover:border-brand hover:ring-2 hover:ring-brand/30"
					@click="selectAsset(asset)"
				>
					<img
						v-if="asset.mimeType?.startsWith('image/')"
						:src="asset.url"
						:alt="asset.alt || asset.filename"
						class="w-full h-full object-contain"
						loading="lazy"
					/>
					<div v-else class="w-full h-full flex flex-col items-center justify-center gap-2 bg-bg-surface p-3">
						<Icon :name="getFileIcon(asset.mimeType || '')" class="w-8 h-8 text-text-tertiary" />
						<span class="text-[10px] text-text-secondary text-center truncate max-w-full px-1">{{ asset.filename }}</span>
					</div>
					<div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
						<p class="text-[10px] text-white truncate">{{ asset.filename }}</p>
						<p class="text-[9px] text-white/70">{{ formatCompactFileSize(asset.fileSize) }}</p>
					</div>
				</button>
			</div>

			<!-- Load more -->
			<div v-if="status === 'CanLoadMore'" class="flex justify-center mt-4">
				<UiButton variant="outline" size="sm" @click="loadMore(20)">Load more</UiButton>
			</div>
		</div>

		<!-- Upload tab -->
		<div v-else>
			<div
				class="flex flex-col items-center justify-center gap-4 p-12 border-2 border-dashed rounded-xl transition-colors"
				:class="isDragOver ? 'border-brand bg-brand-subtle' : 'border-border-subtle'"
				@dragover="handleDragOver"
				@dragleave="handleDragLeave"
				@drop="handleDrop"
			>
				<Icon name="lucide:upload-cloud" class="w-10 h-10 text-text-tertiary" />
				<p class="text-sm text-text-secondary">Drag and drop {{ allowAllFiles ? 'a file' : 'an image' }}, or</p>
				<UiButton variant="outline" size="sm" :loading="isUploading" @click="fileInputRef?.click()">
					Browse files
				</UiButton>
				<input
					ref="fileInputRef"
					type="file"
					class="hidden"
					:accept="resolvedAccept"
					@change="handleFileInput"
				/>
			</div>
		</div>
	</UiModal>
</template>
