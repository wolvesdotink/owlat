import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';

type SourceType = 'upload' | 'email_attachment' | 'agent_generated';

export function useSemanticFiles() {
	const { t } = useI18n();
	const { showToast } = useToast();

	// Search — debounced so each keystroke doesn't tear down and re-subscribe the
	// paginated query (which would flash the grid empty).
	const { query: searchQuery, debouncedQuery } = useDebouncedSearch(300);

	// Filters
	const sourceFilter = ref<SourceType | null>(null);

	// View mode
	const viewMode = ref<'grid' | 'list'>('grid');

	const PAGE_SIZE = 24;

	// Four reads, exactly one live at a time. A source filter goes to its own
	// endpoint (`listBySource` / `searchBySource`), which narrows through an
	// index before paginating, so a filtered page is a page of matches. Each
	// function keeps its own cursors: the Convex client pages a subscription
	// keyed by function and args, so switching the filter never hands one
	// query's cursor to another. A released read stays warm for a while
	// (sharedConvexSubscriptions), so switching back resumes its loaded pages.
	// All four return compact cards, not whole rows with their vectors and
	// extracted text.
	const list = usePaginatedQuery(
		api.files.cards.list,
		() => (debouncedQuery.value || sourceFilter.value ? 'skip' : {}),
		{ initialNumItems: PAGE_SIZE }
	);
	const listBySource = usePaginatedQuery(
		api.files.cards.listBySource,
		() =>
			!debouncedQuery.value && sourceFilter.value ? { sourceType: sourceFilter.value } : 'skip',
		{ initialNumItems: PAGE_SIZE }
	);
	const search = usePaginatedQuery(
		api.files.cards.search,
		() => (debouncedQuery.value && !sourceFilter.value ? { query: debouncedQuery.value } : 'skip'),
		{ initialNumItems: PAGE_SIZE }
	);
	const searchBySource = usePaginatedQuery(
		api.files.cards.searchBySource,
		() =>
			debouncedQuery.value && sourceFilter.value
				? { query: debouncedQuery.value, sourceType: sourceFilter.value }
				: 'skip',
		{ initialNumItems: PAGE_SIZE }
	);

	const active = computed(() => {
		if (debouncedQuery.value) return sourceFilter.value ? searchBySource : search;
		return sourceFilter.value ? listBySource : list;
	});

	// No automatic page loads: a page can still come back short, or empty with
	// more to load, when the read gate drops files the member may not open. The
	// page offers "Load more" for as long as `status` says there is more.
	const files = computed(() => active.value.results.value);
	const status = computed(() => active.value.status.value);
	const isLoading = computed(() => active.value.isLoading.value);
	const error = computed(() => active.value.error.value);
	const refetch = () => active.value.refetch();
	const loadMore = () => active.value.loadMore(PAGE_SIZE);

	// Mutations
	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.useSemanticFiles.getUploadUrl'),
	});
	const { run: createFile } = useBackendOperation(api.semanticFiles.create, {
		label: () => t('shared.useSemanticFiles.uploadFile'),
	});
	const { run: updateFile } = useBackendOperation(api.semanticFiles.update, {
		label: () => t('shared.useSemanticFiles.updateFile'),
	});
	const { run: removeFileMutation } = useBackendOperation(api.semanticFiles.remove, {
		label: () => t('shared.useSemanticFiles.deleteFile'),
	});

	// Upload state
	const isUploading = ref(false);

	const upload = async (
		file: File,
		options?: {
			title?: string;
			tags?: string[];
			sourceType?: SourceType;
			contactIds?: Id<'contacts'>[];
			threadId?: Id<'conversationThreads'>;
			previousVersionId?: Id<'semanticFiles'>;
		}
	) => {
		// Guard the advertised size ceiling client-side so the user gets immediate
		// feedback instead of consuming an upload slot before the server rejects it.
		if (file.size > MAX_LIBRARY_FILE_BYTES) {
			showToast(t('shared.useSemanticFiles.tooLarge', { limit: MAX_LIBRARY_FILE_MB }), 'error');
			return undefined;
		}
		isUploading.value = true;
		try {
			const upload = await uploadFileToStorage(file, () => generateUploadUrl({}));
			if (!upload.ok) {
				if (upload.reason === 'upload-failed')
					showToast(t('shared.useSemanticFiles.uploadFailed'), 'error');
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
			if (!fileId.ok) return undefined;

			showToast(t('shared.useSemanticFiles.uploaded'));
			return fileId.result;
		} finally {
			isUploading.value = false;
		}
	};

	const editFile = async (
		fileId: Id<'semanticFiles'>,
		patch: {
			title?: string;
			tags?: string[];
			contactIds?: Id<'contacts'>[];
		}
	) => {
		const result = await updateFile({ fileId, ...patch });
		if (!result.ok) return;
		showToast(t('shared.useSemanticFiles.updated'));
	};

	const removeFile = async (fileId: Id<'semanticFiles'>) => {
		const result = await removeFileMutation({ fileId });
		if (!result.ok) return;
		showToast(t('shared.useSemanticFiles.deleted'));
	};

	return {
		// Data
		files,
		status,
		isLoading,
		error,
		refetch,
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
