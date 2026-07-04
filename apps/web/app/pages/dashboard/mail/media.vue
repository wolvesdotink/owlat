<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Media Library — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const {
	assets,
	stats,
	tags,
	status,
	isLoading,
	isUploading,
	searchQuery,
	selectedTag,
	selectedTypes,
	selectedAssets,
	toggleSelect,
	clearSelection,
	loadMore,
	uploadFiles,
	deleteAssets,
	updateAsset,
} = useMediaLibrary();

// Uploading, deleting and editing media is admin-only on the backend
// (mediaAssets mutations require the 'media:manage' permission, which maps
// to owner/admin), so hide those affordances for non-admin members.
const { isAdmin } = usePermissions();

const typeFilterOptions = [
	{ value: 'image/', label: 'Images', icon: 'lucide:image' },
	{ value: 'application/pdf', label: 'PDF', icon: 'lucide:file-text' },
	{ value: 'video/', label: 'Video', icon: 'lucide:film' },
	{ value: 'audio/', label: 'Audio', icon: 'lucide:music' },
];

const toggleTypeFilter = (value: string) => {
	const idx = selectedTypes.value.indexOf(value);
	if (idx >= 0) {
		selectedTypes.value = selectedTypes.value.filter((v) => v !== value);
	} else {
		selectedTypes.value = [...selectedTypes.value, value];
	}
};

const tagFilterOptions = computed(() =>
	(tags.value || []).map((tag: string) => ({ value: tag, label: tag }))
);

const getFileIcon = (mimeType: string) => {
	if (mimeType === 'application/pdf') return 'lucide:file-text';
	if (mimeType.startsWith('video/')) return 'lucide:film';
	if (mimeType.startsWith('audio/')) return 'lucide:music';
	return 'lucide:file';
};

// File input ref
const fileInputRef = ref<HTMLInputElement | null>(null);

// Drag state — only admins may drop-upload into the shared media library.
const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDropZone(
	(files) => {
		void uploadFiles(files);
	},
	{ enabled: () => isAdmin.value }
);

// Detail modal
const detailAsset = ref<(typeof assets.value)[0] | null>(null);
const editAlt = ref('');
const editTags = ref('');

const openDetail = (asset: (typeof assets.value)[0]) => {
	detailAsset.value = asset;
	editAlt.value = asset.alt || '';
	editTags.value = (asset.tags || []).join(', ');
};

// How many templates / transactional emails reference the open asset. Reactive
// one-shot query, skipped until a detail asset is selected.
const { data: usage } = useConvexQuery(api.mediaAssets.countUsage, () =>
	detailAsset.value ? { assetId: detailAsset.value._id } : 'skip'
);
const usageCount = computed(() => usage.value?.count ?? null);

const saveDetail = async () => {
	if (!detailAsset.value) return;
	const tagArray = editTags.value
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	await updateAsset(detailAsset.value._id, {
		alt: editAlt.value,
		tags: tagArray,
	});
	detailAsset.value = null;
};

// Delete confirmation
const showDeleteConfirm = ref(false);
const handleBulkDelete = async () => {
	const ids = [...selectedAssets.value] as Id<'mediaAssets'>[];
	await deleteAssets(ids);
	showDeleteConfirm.value = false;
};

// Upload handlers
const handleFileSelect = (event: Event) => {
	const input = event.target as HTMLInputElement;
	if (input.files?.length) {
		uploadFiles(Array.from(input.files));
		input.value = '';
	}
};

const { copy: copyToClipboard } = useCopyToClipboard();
const copyUrl = async (url: string) => {
	await copyToClipboard(url);
	const { showToast } = useToast();
	showToast('URL copied to clipboard');
};
</script>

<template>
	<div
		class="p-6 max-w-7xl mx-auto"
		@dragover="handleDragOver"
		@dragleave="handleDragLeave"
		@drop="handleDrop"
	>
		<!-- Header -->
		<div class="flex items-center justify-between mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Media Library</h1>
				<p v-if="stats" class="text-sm text-text-secondary mt-1">
					{{ stats.totalCount }} files &middot; {{ formatCompactFileSize(stats.totalBytes) }} used
				</p>
			</div>
			<div v-if="isAdmin" class="flex items-center gap-2">
				<UiButton
					v-if="selectedAssets.size > 0"
					variant="outline"
					size="sm"
					class="!text-error !border-error"
					@click="showDeleteConfirm = true"
				>
					<template #iconLeft>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</template>
					Delete ({{ selectedAssets.size }})
				</UiButton>
				<UiButton variant="primary" size="sm" :loading="isUploading" @click="fileInputRef?.click()">
					<template #iconLeft>
						<Icon name="lucide:upload" class="w-4 h-4" />
					</template>
					Upload
				</UiButton>
				<input
					ref="fileInputRef"
					type="file"
					class="hidden"
					multiple
					accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf,video/*,audio/*"
					@change="handleFileSelect"
				/>
			</div>
		</div>

		<!-- Filters -->
		<div class="flex items-center gap-3 mb-6">
			<div class="flex-1 max-w-sm">
				<UiInput v-model="searchQuery" placeholder="Search media..." />
			</div>
			<div class="flex items-center gap-1.5">
				<button
					v-for="opt in typeFilterOptions"
					:key="opt.value"
					type="button"
					class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors"
					:class="
						selectedTypes.includes(opt.value)
							? 'bg-brand/10 border-brand text-brand'
							: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary'
					"
					@click="toggleTypeFilter(opt.value)"
				>
					<Icon :name="opt.icon" class="w-3.5 h-3.5" />
					{{ opt.label }}
				</button>
			</div>
			<UiSelect
				v-if="tags && tags.length > 0"
				v-model="selectedTag"
				:options="tagFilterOptions"
				placeholder="All tags"
			/>
		</div>

		<!-- Drag overlay -->
		<Transition
			enter-active-class="transition-opacity duration-(--motion-fast)"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-(--motion-fast-exit)"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isDragOver"
				class="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/80 backdrop-blur-sm pointer-events-none"
			>
				<div
					class="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-brand rounded-xl bg-bg-elevated"
				>
					<Icon name="lucide:upload-cloud" class="w-12 h-12 text-brand" />
					<p class="text-lg font-medium text-text-primary">Drop files to upload</p>
				</div>
			</div>
		</Transition>

		<!-- Loading -->
		<div v-if="isLoading && assets.length === 0" class="flex items-center justify-center py-20">
			<UiSpinner />
		</div>

		<!-- Empty state -->
		<UiEmptyState
			v-else-if="assets.length === 0 && !searchQuery && !selectedTag && selectedTypes.length === 0"
			title="No media yet"
			:description="
				isAdmin
					? 'Upload images to use across your email templates.'
					: 'Media will appear here once an admin uploads it.'
			"
			icon="lucide:image"
		>
			<UiButton v-if="isAdmin" variant="primary" size="sm" @click="fileInputRef?.click()">
				<template #iconLeft>
					<Icon name="lucide:upload" class="w-4 h-4" />
				</template>
				Upload your first image
			</UiButton>
		</UiEmptyState>

		<!-- No results -->
		<div v-else-if="assets.length === 0" class="text-center py-16 text-text-secondary">
			No media found matching your search.
		</div>

		<!-- Asset grid -->
		<div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
			<div
				v-for="asset in assets"
				:key="asset._id"
				class="group relative bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden cursor-pointer transition-all duration-(--motion-moderate) hover:border-border-default hover:shadow-sm"
				:class="{ 'ring-2 ring-brand border-brand': selectedAssets.has(asset._id) }"
				@click="openDetail(asset)"
			>
				<!-- Checkbox (selection only drives bulk delete, which is admin-only) -->
				<div v-if="isAdmin" class="absolute top-2 left-2 z-10">
					<UiCheckbox
						:model-value="selectedAssets.has(asset._id)"
						class="opacity-0 group-hover:opacity-100 transition-opacity"
						:class="{ '!opacity-100': selectedAssets.has(asset._id) }"
						@update:model-value="toggleSelect(asset._id)"
						@click.stop
					/>
				</div>

				<!-- Thumbnail -->
				<div class="aspect-square bg-checker flex items-center justify-center overflow-hidden">
					<img
						v-if="asset.mimeType?.startsWith('image/')"
						:src="asset.url"
						:alt="asset.alt || asset.filename"
						class="w-full h-full object-contain"
						loading="lazy"
					/>
					<div
						v-else
						class="flex flex-col items-center justify-center gap-2 bg-bg-surface w-full h-full p-3"
					>
						<Icon :name="getFileIcon(asset.mimeType || '')" class="w-10 h-10 text-text-tertiary" />
						<span class="text-[10px] text-text-secondary text-center truncate max-w-full px-1">{{
							asset.filename
						}}</span>
					</div>
				</div>

				<!-- Info -->
				<div class="px-3 py-2">
					<p class="text-xs font-medium text-text-primary truncate">{{ asset.filename }}</p>
					<div class="flex items-center gap-2 mt-0.5">
						<span v-if="asset.width && asset.height" class="text-[10px] text-text-tertiary">
							{{ asset.width }}&times;{{ asset.height }}
						</span>
						<span class="text-[10px] text-text-tertiary">{{
							formatCompactFileSize(asset.fileSize)
						}}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Load more -->
		<div v-if="status === 'CanLoadMore'" class="flex justify-center mt-8">
			<UiButton variant="outline" size="sm" @click="loadMore(24)"> Load more </UiButton>
		</div>

		<!-- Detail Modal -->
		<UiModal
			:open="!!detailAsset"
			title="Asset Details"
			size="lg"
			@update:open="
				(v: boolean) => {
					if (!v) detailAsset = null;
				}
			"
		>
			<template v-if="detailAsset">
				<div class="flex flex-col md:flex-row gap-6">
					<!-- Preview -->
					<div class="md:w-1/2 flex-shrink-0">
						<div
							class="aspect-square bg-checker rounded-lg overflow-hidden flex items-center justify-center"
						>
							<img
								v-if="detailAsset.mimeType?.startsWith('image/')"
								:src="detailAsset.url"
								:alt="detailAsset.alt || detailAsset.filename"
								class="max-w-full max-h-full object-contain"
							/>
							<div v-else class="flex flex-col items-center justify-center gap-3">
								<Icon
									:name="getFileIcon(detailAsset.mimeType || '')"
									class="w-16 h-16 text-text-tertiary"
								/>
								<span class="text-sm text-text-secondary">{{ detailAsset.filename }}</span>
							</div>
						</div>
					</div>
					<!-- Fields -->
					<div class="flex-1 space-y-4">
						<div>
							<p class="text-sm font-medium text-text-primary">{{ detailAsset.filename }}</p>
							<p class="text-xs text-text-tertiary mt-1">
								{{ formatCompactFileSize(detailAsset.fileSize) }}
								<template v-if="detailAsset.width && detailAsset.height">
									&middot; {{ detailAsset.width }}&times;{{ detailAsset.height }}
								</template>
							</p>
							<p v-if="usageCount !== null" class="text-xs text-text-secondary mt-1">
								{{
									usageCount === 0
										? 'Not used in any email yet'
										: `Used in ${usageCount} email${usageCount === 1 ? '' : 's'}`
								}}
							</p>
						</div>

						<template v-if="isAdmin">
							<UiInput v-model="editAlt" label="Alt text" placeholder="Describe this image..." />
							<UiInput v-model="editTags" label="Tags" placeholder="Comma-separated tags..." />
						</template>
						<template v-else>
							<div v-if="detailAsset.alt">
								<p class="text-xs font-medium text-text-secondary mb-1">Alt text</p>
								<p class="text-sm text-text-primary">{{ detailAsset.alt }}</p>
							</div>
							<div v-if="detailAsset.tags && detailAsset.tags.length">
								<p class="text-xs font-medium text-text-secondary mb-1">Tags</p>
								<p class="text-sm text-text-primary">{{ detailAsset.tags.join(', ') }}</p>
							</div>
						</template>

						<div class="flex items-center gap-2 pt-2">
							<UiButton variant="outline" size="sm" @click="copyUrl(detailAsset.url)">
								<template #iconLeft>
									<Icon name="lucide:copy" class="w-3.5 h-3.5" />
								</template>
								Copy URL
							</UiButton>
							<UiButton
								v-if="isAdmin"
								variant="outline"
								size="sm"
								class="!text-error !border-error"
								@click="
									deleteAssets([detailAsset!._id]);
									detailAsset = null;
								"
							>
								<template #iconLeft>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								</template>
								Delete
							</UiButton>
						</div>
					</div>
				</div>
			</template>

			<template #footer>
				<UiButton variant="secondary" @click="detailAsset = null">{{
					isAdmin ? 'Cancel' : 'Close'
				}}</UiButton>
				<UiButton v-if="isAdmin" variant="primary" @click="saveDetail">Save</UiButton>
			</template>
		</UiModal>

		<!-- Bulk delete confirmation -->
		<UiConfirmationDialog
			:open="showDeleteConfirm"
			title="Delete selected media"
			:description="`Are you sure you want to delete ${selectedAssets.size} selected asset(s)? This cannot be undone.`"
			confirm-text="Delete"
			variant="danger"
			@confirm="handleBulkDelete"
			@cancel="showDeleteConfirm = false"
		/>
	</div>
</template>
