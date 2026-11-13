<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import SendMediaAssetDetailModal, {
	getFileIcon,
} from '~/components/send/MediaAssetDetailModal.vue';
import {
	CloudUploadIcon,
	FileTextIcon,
	FilmIcon,
	ImageIcon,
	MusicNoteIcon,
	TrashIcon,
	UploadIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.media.pageTitle') });

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
	error: assetsError,
	refetch: refetchAssets,
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

const typeFilterOptions = computed(() => [
	{ value: 'image/', label: t('dashboard.send.media.types.images'), icon: ImageIcon },
	{
		value: 'application/pdf',
		label: t('dashboard.send.media.types.pdf'),
		icon: FileTextIcon,
	},
	{ value: 'video/', label: t('dashboard.send.media.types.video'), icon: FilmIcon },
	{ value: 'audio/', label: t('dashboard.send.media.types.audio'), icon: MusicNoteIcon },
]);

const toggleTypeFilter = (value: string) => {
	const idx = selectedTypes.value.indexOf(value);
	if (idx >= 0) {
		selectedTypes.value = selectedTypes.value.filter((v) => v !== value);
	} else {
		selectedTypes.value = [...selectedTypes.value, value];
	}
};

// "All tags" is an option, not only the placeholder: once a tag is picked,
// the select has no other way back to the unfiltered library.
const tagFilterOptions = computed(() => [
	{ value: '', label: t('dashboard.send.media.allTags') },
	...(tags.value || []).map((tag: string) => ({ value: tag, label: tag })),
]);

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
const openDetail = (asset: (typeof assets.value)[0]) => {
	detailAsset.value = asset;
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
</script>

<template>
	<div
		class="mx-auto w-full max-w-page p-6 lg:p-8"
		@dragover="handleDragOver"
		@dragleave="handleDragLeave"
		@drop="handleDrop"
	>
		<UiPageHeader
			:title="t('dashboard.send.media.title')"
			:description="
				stats
					? t('dashboard.send.media.stats', {
							count: stats.totalCount,
							size: formatCompactFileSize(stats.totalBytes),
						})
					: undefined
			"
			class="mb-6"
		>
			<template v-if="isAdmin" #actions>
				<UiButton
					v-if="selectedAssets.size > 0"
					variant="danger-outline"
					size="sm"
					@click="showDeleteConfirm = true"
				>
					<template #iconLeft>
						<TrashIcon class="w-4 h-4" />
					</template>
					{{ t('dashboard.send.media.deleteSelected', { count: selectedAssets.size }) }}
				</UiButton>
				<UiButton variant="primary" size="sm" :loading="isUploading" @click="fileInputRef?.click()">
					<template #iconLeft>
						<UploadIcon class="w-4 h-4" />
					</template>
					{{ t('common.upload') }}
				</UiButton>
				<input
					ref="fileInputRef"
					type="file"
					class="hidden"
					multiple
					accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf,video/*,audio/*"
					@change="handleFileSelect"
				/>
			</template>
		</UiPageHeader>

		<!-- Filters: wraps on phones, where search takes its own full-width line
		     instead of being squeezed to nothing by the type chips. -->
		<div class="flex flex-wrap items-center gap-3 mb-6">
			<div class="w-full sm:w-auto sm:flex-1 sm:max-w-sm">
				<UiInput
					v-model="searchQuery"
					:placeholder="t('dashboard.send.media.searchPlaceholder')"
					:aria-label="t('dashboard.send.media.searchLabel')"
				/>
			</div>
			<div class="flex flex-wrap items-center gap-1.5">
				<button
					v-for="opt in typeFilterOptions"
					:key="opt.value"
					type="button"
					:aria-pressed="selectedTypes.includes(opt.value)"
					class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:min-h-11"
					:class="
						selectedTypes.includes(opt.value)
							? 'bg-brand/10 border-brand text-brand'
							: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary'
					"
					@click="toggleTypeFilter(opt.value)"
				>
					<component :is="opt.icon" class="w-3.5 h-3.5" />
					{{ opt.label }}
				</button>
			</div>
			<UiSelect
				v-if="tags && tags.length > 0"
				v-model="selectedTag"
				:options="tagFilterOptions"
				:placeholder="t('dashboard.send.media.allTags')"
				:aria-label="t('dashboard.send.media.tags')"
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
					<CloudUploadIcon class="w-12 h-12 text-brand" :stroke-width="1.5" />
					<p class="text-lg font-medium text-text-primary">
						{{ t('dashboard.send.media.dropToUpload') }}
					</p>
				</div>
			</div>
		</Transition>

		<!-- A failed read is not an empty library. -->
		<UiQueryBoundary
			v-if="assetsError"
			:error="assetsError"
			:error-title="t('dashboard.send.media.loadError')"
			@retry="refetchAssets"
		/>

		<!-- Loading -->
		<div
			v-else-if="isLoading && assets.length === 0"
			class="flex items-center justify-center py-20"
		>
			<UiSpinner delay />
		</div>

		<!-- Empty state -->
		<UiEmptyState
			v-else-if="assets.length === 0 && !searchQuery && !selectedTag && selectedTypes.length === 0"
			:title="t('dashboard.send.media.emptyTitle')"
			:description="
				isAdmin
					? t('dashboard.send.media.emptyDescriptionAdmin')
					: t('dashboard.send.media.emptyDescriptionMember')
			"
			:icon="ImageIcon"
		>
			<UiButton v-if="isAdmin" variant="primary" size="sm" @click="fileInputRef?.click()">
				<template #iconLeft>
					<UploadIcon class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.media.uploadFirst') }}
			</UiButton>
		</UiEmptyState>

		<!-- No results -->
		<div v-else-if="assets.length === 0" class="text-center py-16 text-text-secondary">
			{{ t('dashboard.send.media.noResults') }}
		</div>

		<!-- Asset grid -->
		<div
			v-else
			class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6 gap-4"
		>
			<div
				v-for="asset in assets"
				:key="asset._id"
				class="group relative bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden transition-[border-color,box-shadow] duration-(--motion-moderate) hover:border-border-default hover:shadow-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand"
				:class="{ 'ring-2 ring-brand border-brand': selectedAssets.has(asset._id) }"
			>
				<!-- Checkbox (selection only drives bulk delete, which is admin-only) -->
				<div v-if="isAdmin" class="absolute top-2 left-2 z-10">
					<UiCheckbox
						:model-value="selectedAssets.has(asset._id)"
						:aria-label="t('dashboard.send.media.selectAsset', { name: asset.filename })"
						class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity"
						:class="{ '!opacity-100': selectedAssets.has(asset._id) }"
						@update:model-value="toggleSelect(asset._id)"
					/>
				</div>

				<!-- The tile opens the asset's details: alt text, tags, URL, delete. -->
				<button
					type="button"
					class="block w-full cursor-pointer text-left focus-visible:outline-none"
					:aria-label="t('dashboard.send.media.openAsset', { name: asset.filename })"
					@click="openDetail(asset)"
				>
					<!-- Thumbnail -->
					<span class="aspect-square bg-checker flex items-center justify-center overflow-hidden">
						<img
							v-if="asset.mimeType?.startsWith('image/')"
							:src="asset.url"
							:alt="asset.alt || asset.filename"
							class="w-full h-full object-contain"
							loading="lazy"
						/>
						<span
							v-else
							class="flex flex-col items-center justify-center gap-2 bg-bg-surface w-full h-full p-3"
						>
							<component
								:is="getFileIcon(asset.mimeType || '')"
								class="w-10 h-10 text-text-tertiary"
								:stroke-width="1.5"
							/>
							<span class="text-2xs text-text-secondary text-center truncate max-w-full px-1">{{
								asset.filename
							}}</span>
						</span>
					</span>

					<!-- Info -->
					<span class="block px-3 py-2">
						<span
							class="block text-xs font-medium text-text-primary truncate"
							:title="asset.filename"
							>{{ asset.filename }}</span
						>
						<span class="flex items-center gap-2 mt-0.5">
							<span v-if="asset.width && asset.height" class="text-2xs text-text-tertiary">
								{{ asset.width }}&times;{{ asset.height }}
							</span>
							<span class="text-2xs text-text-tertiary">{{
								formatCompactFileSize(asset.fileSize)
							}}</span>
						</span>
					</span>
				</button>
			</div>
		</div>

		<!-- Load more -->
		<div v-if="status === 'CanLoadMore'" class="flex justify-center mt-8">
			<UiButton variant="outline" size="sm" @click="loadMore(24)">
				{{ t('dashboard.send.media.loadMore') }}
			</UiButton>
		</div>

		<!-- Detail Modal -->
		<SendMediaAssetDetailModal
			v-model:asset="detailAsset"
			:is-admin="isAdmin"
			:update-asset="updateAsset"
			:delete-assets="deleteAssets"
		/>

		<!-- Bulk delete confirmation -->
		<UiConfirmationDialog
			:open="showDeleteConfirm"
			:title="t('dashboard.send.media.deleteTitle')"
			:description="t('dashboard.send.media.deleteDescription', { count: selectedAssets.size })"
			:confirm-text="t('common.delete')"
			variant="danger"
			@confirm="handleBulkDelete"
			@cancel="showDeleteConfirm = false"
		/>
	</div>
</template>
