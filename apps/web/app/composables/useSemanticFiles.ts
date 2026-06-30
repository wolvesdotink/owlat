import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';

type SourceType = 'upload' | 'email_attachment' | 'agent_generated';

export function useSemanticFiles() {
	const { showToast } = useToast();

	// Search — debounced so each keystroke doesn't tear down and re-subscribe the
	// paginated query (which would flash the grid empty).
	const { query: searchQuery, debouncedQuery } = useDebouncedSearch(300);

	// Filters
	const sourceFilter = ref<SourceType | null>(null);

	// View mode
	const viewMode = ref<'grid' | 'list'>('grid');

	const PAGE_SIZE = 24;

	// List query (used when no search query). sourceType is pushed to the backend
	// so the filter spans the whole table, not just one fetched page.
	const list = usePaginatedQuery(
		api.semanticFiles.list,
		() => debouncedQuery.value
			? 'skip'
			: { sourceType: sourceFilter.value ?? undefined },
		{ initialNumItems: PAGE_SIZE },
	);

	// Search query (used when search is active)
	const search = usePaginatedQuery(
		api.semanticFiles.search,
		() => debouncedQuery.value
			? { query: debouncedQuery.value, sourceType: sourceFilter.value ?? undefined }
			: 'skip',
		{ initialNumItems: PAGE_SIZE },
	);

	const active = computed(() => (debouncedQuery.value ? search : list));

	const files = computed(() => active.value.results.value);
	const status = computed(() => active.value.status.value);
	const isLoading = computed(() => active.value.isLoading.value);
	const loadMore = () => active.value.loadMore(PAGE_SIZE);

	// `sourceType` is applied as a POST-pagination filter by the backend, so a
	// page can come back sparse (or empty) while matching files sit on later
	// pages. When the filter is active, auto-load further pages until the grid is
	// filled or the list is exhausted — capped so a rare match can't scan the
	// whole table. Mirrors useMediaLibrary.
	const MAX_AUTO_LOADS = 8;
	let autoLoadCount = 0;
	watch([() => files.value.length, status], () => {
		if (
			sourceFilter.value &&
			status.value === 'CanLoadMore' &&
			files.value.length < PAGE_SIZE &&
			autoLoadCount < MAX_AUTO_LOADS
		) {
			autoLoadCount += 1;
			loadMore();
		}
	});
	watch([debouncedQuery, sourceFilter], () => {
		autoLoadCount = 0;
	});

	// Mutations
	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: 'Get upload URL',
	});
	const { run: createFile } = useBackendOperation(api.semanticFiles.create, {
		label: 'Upload file',
	});
	const { run: updateFile } = useBackendOperation(api.semanticFiles.update, {
		label: 'Update file',
	});
	const { run: removeFileMutation } = useBackendOperation(api.semanticFiles.remove, {
		label: 'Delete file',
	});

	// Upload state
	const isUploading = ref(false);

	const upload = async (file: File, options?: {
		title?: string;
		tags?: string[];
		sourceType?: SourceType;
		contactIds?: Id<'contacts'>[];
		threadId?: Id<'conversationThreads'>;
		previousVersionId?: Id<'semanticFiles'>;
	}) => {
		// Guard the advertised size ceiling client-side so the user gets immediate
		// feedback instead of consuming an upload slot before the server rejects it.
		if (file.size > MAX_LIBRARY_FILE_BYTES) {
			showToast(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`, 'error');
			return undefined;
		}
		isUploading.value = true;
		try {
			const upload = await uploadFileToStorage(file, () => generateUploadUrl({}));
			if (!upload.ok) {
				if (upload.reason === 'upload-failed') showToast('Failed to upload file', 'error');
				return undefined;
			}
			const storageId = upload.storageId;

			const fileId = await createFile({
				storageId,
				filename: file.name,
				mimeType: file.type || 'application/octet-stream',
				fileSize: file.size,
				title: options?.title,
				tags: options?.tags,
				sourceType: options?.sourceType ?? 'upload',
				contactIds: options?.contactIds,
				threadId: options?.threadId,
				previousVersionId: options?.previousVersionId,
			});
			if (fileId === undefined) return undefined;

			showToast('File uploaded successfully');
			return fileId;
		} finally {
			isUploading.value = false;
		}
	};

	const editFile = async (fileId: Id<'semanticFiles'>, patch: {
		title?: string;
		tags?: string[];
		contactIds?: Id<'contacts'>[];
	}) => {
		const result = await updateFile({ fileId, ...patch });
		if (result === undefined) return;
		showToast('File updated');
	};

	const removeFile = async (fileId: Id<'semanticFiles'>) => {
		const result = await removeFileMutation({ fileId });
		if (result === undefined) return;
		showToast('File deleted');
	};

	return {
		// Data
		files,
		status,
		isLoading,
		isUploading,
		// Filters
		searchQuery,
		sourceFilter,
		// View
		viewMode,
		// Actions
		loadMore,
		upload,
		editFile,
		removeFile,
	};
}
