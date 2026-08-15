import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getImageDimensions } from '~/utils/getImageDimensions';

export function useMediaLibrary() {
	const { t } = useI18n();
	const { showToast } = useToast();

	// Filter state — search is debounced so each keystroke doesn't tear down and
	// re-subscribe the paginated query (which would flash the grid empty).
	const { searchQuery, debouncedSearch } = useDebouncedSearch(300);
	const selectedTag = ref<string | null>(null);
	const selectedTypes = ref<string[]>([]);

	// Paginated assets query
	const PAGE_SIZE = 24;
	const {
		results: assets,
		status,
		loadMore,
		isLoading,
	} = usePaginatedQuery(
		api.mediaAssets.list,
		() => ({
			search: debouncedSearch.value || undefined,
			tag: selectedTag.value || undefined,
			mimeTypePrefixes: selectedTypes.value.length > 0 ? selectedTypes.value : undefined,
		}),
		{ initialNumItems: PAGE_SIZE }
	);

	// tag/mimeTypePrefixes are applied as POST-pagination filters by the backend,
	// so a page can come back sparse (or empty) while matching assets sit on
	// later pages. When a filter is active, auto-load further pages until the
	// grid is filled or the list is exhausted — capped so a rare match can't
	// scan the whole table.
	const hasActiveFilter = computed(
		() => !!(debouncedSearch.value || selectedTag.value || selectedTypes.value.length)
	);
	const MAX_AUTO_LOADS = 8;
	let autoLoadCount = 0;
	watch([() => assets.value.length, status], () => {
		if (
			hasActiveFilter.value &&
			status.value === 'CanLoadMore' &&
			assets.value.length < PAGE_SIZE &&
			autoLoadCount < MAX_AUTO_LOADS
		) {
			autoLoadCount += 1;
			loadMore(PAGE_SIZE);
		}
	});
	watch([debouncedSearch, selectedTag, selectedTypes], () => {
		autoLoadCount = 0;
	});

	// Stats
	const { data: stats } = useConvexQuery(api.mediaAssets.getStats, () => ({}));

	// Tags
	const { data: tags } = useConvexQuery(api.mediaAssets.listTags, () => ({}));

	// Multi-select
	const selectedAssets = ref<Set<string>>(new Set());

	const toggleSelect = (assetId: string) => {
		const next = new Set(selectedAssets.value);
		if (next.has(assetId)) {
			next.delete(assetId);
		} else {
			next.add(assetId);
		}
		selectedAssets.value = next;
	};

	const clearSelection = () => {
		selectedAssets.value = new Set();
	};

	// Mutations
	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.useMediaLibrary.operations.getUploadUrl'),
	});
	const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
		label: () => t('shared.useMediaLibrary.operations.saveAsset'),
	});
	const { run: updateMediaAsset } = useBackendOperation(api.mediaAssets.update, {
		label: () => t('shared.useMediaLibrary.operations.updateAsset'),
	});
	const { run: bulkDeleteAssets } = useBackendOperation(api.mediaAssets.bulkDelete, {
		label: () => t('shared.useMediaLibrary.operations.deleteAssets'),
	});

	// Upload files
	const isUploading = ref(false);
	const uploadFiles = async (files: File[]) => {
		isUploading.value = true;
		try {
			const results = await Promise.allSettled(
				files.map(async (file) => {
					const upload = await uploadFileToStorage(file, () => generateUploadUrl({}));
					if (!upload.ok) {
						// Diagnostic only — `allSettled` below counts the rejections and
						// the toast reports the count; these strings never reach the UI.
						throw new Error(
							upload.reason === 'no-url'
								? 'Failed to get upload URL'
								: upload.reason === 'upload-failed'
									? 'Upload failed'
									: 'Upload did not return a storage id'
						);
					}
					const storageId = upload.storageId;
					const dimensions = await getImageDimensions(file);

					const created = await createMediaAsset({
						storageId,
						filename: file.name,
						mimeType: file.type,
						fileSize: file.size,
						width: dimensions?.width,
						height: dimensions?.height,
					});
					if (created === undefined) throw new Error('Failed to save media asset');
				})
			);
			const failed = results.filter((r) => r.status === 'rejected').length;
			if (failed > 0) {
				showToast(t('shared.useMediaLibrary.toasts.uploadFailed', { count: failed }), 'error');
			}
		} finally {
			isUploading.value = false;
		}
	};

	// Delete
	const deleteAssets = async (ids: Id<'mediaAssets'>[]) => {
		const result = await bulkDeleteAssets({ assetIds: ids });
		if (result === undefined) return;
		clearSelection();
	};

	// Update metadata
	const updateAsset = async (id: Id<'mediaAssets'>, patch: { alt?: string; tags?: string[] }) => {
		await updateMediaAsset({ assetId: id, ...patch });
	};

	return {
		// Data
		assets,
		stats,
		tags,
		status,
		isLoading,
		isUploading,
		// Filters
		searchQuery,
		selectedTag,
		selectedTypes,
		// Selection
		selectedAssets,
		toggleSelect,
		clearSelection,
		// Actions
		loadMore,
		uploadFiles,
		deleteAssets,
		updateAsset,
	};
}
