<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useFileVersionHistory } from '~/composables/useFileVersionHistory';
import {
	ArrowLeftIcon,
	CheckIcon,
	ChevronDownIcon,
	CloseIcon,
	DownloadIcon,
	FileCloseIcon,
	FileIcon,
	FileTextIcon,
	FileTypeIcon,
	FilmIcon,
	ImageIcon,
	MusicNoteIcon,
	PencilIcon,
	SparklesIcon,
	TableIcon,
	TrashIcon,
	UploadIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.files.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const { showToast } = useToast();

// Editing, deleting and uploading new versions of files is admin-only on the
// backend (semanticFiles mutations call requireAdminContext), so hide those
// affordances for non-admin members.
const { isAdmin } = usePermissions();

const fileId = useRouteId<'semanticFiles'>();

// File data
const {
	data: file,
	isLoading,
	error: fileError,
	refetch: refetchFile,
} = useConvexQuery(api.files.library.get, () => ({
	fileId: fileId.value,
}));

// Version history, a page at a time. Read here so it loads alongside the file;
// FilesDetailVersionsSection shows it.
const versionHistory = useFileVersionHistory(() => fileId.value);

// Mutations
const { run: updateFile } = useBackendOperation(api.files.library.update, {
	label: () => t('dashboard.files.detail.updateOperation'),
});
const { run: removeFile } = useBackendOperation(api.files.library.remove, {
	label: () => t('dashboard.files.detail.deleteOperation'),
});

// Title edit state; the tags, contacts and conversation cards keep their own.
const isEditingTitle = ref(false);
const editTitleInput = ref('');

// Delete state
const showDeleteConfirm = ref(false);
const isDeleting = ref(false);

// New-version upload state
const showVersionUpload = ref(false);

const handleVersionUploaded = (newFileId: Id<'semanticFiles'>) => {
	showVersionUpload.value = false;
	// The new upload becomes the head of the version chain; navigate to it so
	// the Version History panel shows the full chain (old version included).
	if (newFileId !== fileId.value) {
		router.push(`/dashboard/files/${newFileId}`);
	}
};

// Collapsible sections
const showSummary = ref(true);
const showExtractedText = ref(false);

// Focus moves into the field on entry and back to the Rename button when the
// edit ends, so a keyboard user keeps their place.
const titleInputRef = ref<HTMLInputElement | null>(null);
const renameButtonRef = ref<{ $el?: HTMLElement } | null>(null);
const startEditTitle = async () => {
	editTitleInput.value = file.value?.title || '';
	isEditingTitle.value = true;
	await nextTick();
	titleInputRef.value?.focus();
	titleInputRef.value?.select();
};
const endEditTitle = async () => {
	isEditingTitle.value = false;
	await nextTick();
	renameButtonRef.value?.$el?.focus();
};

const saveTitle = async () => {
	if (!file.value) return;
	const result = await updateFile({
		fileId: fileId.value,
		title: editTitleInput.value || undefined,
	});
	if (!result.ok) return;
	void endEditTitle();
	showToast(t('dashboard.files.detail.toasts.titleUpdated'));
};

const cancelEditTitle = () => {
	void endEditTitle();
};

const handleDelete = async () => {
	isDeleting.value = true;
	try {
		const result = await removeFile({ fileId: fileId.value });
		if (!result.ok) return;
		showToast(t('dashboard.files.detail.toasts.fileDeleted'));
		router.push('/dashboard/files');
	} finally {
		isDeleting.value = false;
	}
};

// Helpers

const mimeIcon = computed(() => {
	if (!file.value) return FileIcon;
	const mime = file.value.mimeType;
	if (mime === 'application/pdf') return FileTextIcon;
	if (mime.startsWith('image/')) return ImageIcon;
	if (mime.startsWith('video/')) return FilmIcon;
	if (mime.startsWith('audio/')) return MusicNoteIcon;
	if (mime.includes('spreadsheet') || mime.includes('csv')) return TableIcon;
	if (mime.includes('word') || mime.includes('document')) return FileTextIcon;
	if (mime.startsWith('text/')) return FileTypeIcon;
	return FileIcon;
});
</script>

<template>
	<div class="mx-auto w-full max-w-4xl p-6 lg:p-8">
		<!-- Back link -->
		<NuxtLink
			to="/dashboard/files"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
			{{ t('dashboard.files.detail.backToFiles') }}
		</NuxtLink>

		<!-- A failed read is not a missing file. -->
		<UiQueryBoundary v-if="fileError" :error="fileError" @retry="refetchFile" />

		<!-- Loading -->
		<DashboardDetailSkeleton
			v-else-if="isLoading"
			:label="t('dashboard.files.detail.loading')"
			lead="tile-lg"
			meta
			:actions="3"
		/>

		<!-- Not found -->
		<div v-else-if="!file" class="flex flex-col items-center justify-center py-16 text-center">
			<UiIconBox :icon="FileCloseIcon" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.files.detail.notFound') }}
			</p>
			<NuxtLink to="/dashboard/files" class="text-sm text-brand hover:underline mt-2">
				{{ t('dashboard.files.detail.returnToFiles') }}
			</NuxtLink>
		</div>

		<!-- File detail -->
		<template v-else>
			<!-- Header -->
			<div class="flex items-start gap-4 mb-8">
				<div
					class="flex-shrink-0 w-14 h-14 rounded-xl bg-bg-surface shadow-surface-1 flex items-center justify-center"
				>
					<component :is="mimeIcon" class="w-7 h-7 text-text-tertiary" :stroke-width="1.5" />
				</div>
				<UiPageHeader class="min-w-0 flex-1" :description="file.filename">
					<!-- The title edits in place: the editor takes the title's spot in
					     the h1, so the filename, the notes and the actions stay put. -->
					<template #title>
						<span v-if="isEditingTitle" class="inline-flex items-center gap-2">
							<input
								ref="titleInputRef"
								v-model="editTitleInput"
								type="text"
								class="input input-sm font-semibold"
								:aria-label="t('dashboard.files.detail.titleLabel')"
								:placeholder="t('dashboard.files.detail.titlePlaceholder')"
								@keyup.enter="saveTitle"
								@keyup.escape="cancelEditTitle"
							/>
							<button
								type="button"
								class="p-1 rounded text-brand hover:bg-brand-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								@click="saveTitle"
								:aria-label="t('dashboard.files.detail.saveTitle')"
							>
								<CheckIcon class="w-4 h-4" />
							</button>
							<button
								type="button"
								class="p-1 rounded text-text-tertiary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								@click="cancelEditTitle"
								:aria-label="t('dashboard.files.detail.cancelEditingTitle')"
							>
								<CloseIcon class="w-4 h-4" />
							</button>
						</span>
						<span v-else class="inline-flex items-center gap-1.5">
							<span>{{ file.title || file.filename }}</span>
							<UiTooltip v-if="isAdmin" :text="t('dashboard.files.detail.renameFile')">
								<UiButton
									ref="renameButtonRef"
									variant="ghost"
									size="sm"
									class="text-text-tertiary"
									:aria-label="t('dashboard.files.detail.renameFile')"
									@click="startEditTitle"
								>
									<PencilIcon class="w-3.5 h-3.5" aria-hidden="true" />
								</UiButton>
							</UiTooltip>
						</span>
					</template>
					<!--
						The retention sweep releases the BYTES of a team-inbox capture and
						keeps the row, so `url` is null and the download control above simply
						vanishes — the same "the affordance shows nothing at all" shape the
						thread view now explains one screen over. Say it here too.
					-->
					<template v-if="file.bytesReleasedAt" #meta>
						<p class="text-sm text-text-tertiary" data-testid="file-bytes-released">
							{{ t('dashboard.files.detail.bytesReleased') }}
						</p>
					</template>
					<template v-if="file.url || isAdmin" #actions>
						<UiButton
							variant="secondary"
							v-if="file.url"
							:href="file.url"
							target="_blank"
							rel="noopener noreferrer"
						>
							<DownloadIcon class="w-4 h-4 mr-2" />
							{{ t('common.download') }}
						</UiButton>
						<UiButton variant="secondary" v-if="isAdmin" @click="showVersionUpload = true">
							<UploadIcon class="w-4 h-4 mr-2" />
							{{ t('dashboard.files.detail.newVersion') }}
						</UiButton>
						<UiButton v-if="isAdmin" variant="danger-outline" @click="showDeleteConfirm = true">
							<TrashIcon class="w-4 h-4 mr-2" />
							{{ t('common.delete') }}
						</UiButton>
					</template>
				</UiPageHeader>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main content -->
				<div class="lg:col-span-2 space-y-6">
					<!-- AI Summary -->
					<div v-if="file.summary" class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card)">
						<button
							type="button"
							class="w-full flex items-center justify-between px-5 py-4 rounded-(--radius-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-expanded="showSummary"
							aria-controls="file-summary-panel"
							@click="showSummary = !showSummary"
						>
							<div class="flex items-center gap-2">
								<SparklesIcon class="w-4 h-4 text-brand" aria-hidden="true" />
								<span class="text-sm font-medium text-text-primary">{{
									t('dashboard.files.detail.aiSummary')
								}}</span>
							</div>
							<ChevronDownIcon
								class="w-4 h-4 text-text-tertiary transition-transform"
								:class="{ '-rotate-180': showSummary }"
								aria-hidden="true"
							/>
						</button>
						<div v-if="showSummary" id="file-summary-panel" class="px-5 pb-4">
							<p class="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
								{{ file.summary }}
							</p>
						</div>
					</div>

					<!-- Extracted text -->
					<div
						v-if="file.extractedText"
						class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card)"
					>
						<button
							type="button"
							class="w-full flex items-center justify-between px-5 py-4 rounded-(--radius-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-expanded="showExtractedText"
							aria-controls="file-extracted-text-panel"
							@click="showExtractedText = !showExtractedText"
						>
							<div class="flex items-center gap-2">
								<FileTextIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
								<span class="text-sm font-medium text-text-primary">{{
									t('dashboard.files.detail.extractedText')
								}}</span>
							</div>
							<ChevronDownIcon
								class="w-4 h-4 text-text-tertiary transition-transform"
								:class="{ '-rotate-180': showExtractedText }"
								aria-hidden="true"
							/>
						</button>
						<div v-if="showExtractedText" id="file-extracted-text-panel" class="px-5 pb-4">
							<pre
								class="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap font-mono bg-bg-surface rounded-lg p-4 max-h-96 overflow-y-auto"
								>{{ file.extractedText }}</pre>
						</div>
					</div>

					<!-- Version history -->
					<FilesDetailVersionsSection :history="versionHistory" :current-version-id="file._id" />
				</div>

				<!-- Sidebar metadata -->
				<div class="space-y-6">
					<!-- File info -->
					<FilesDetailInfoCard
						:mime-type="file.mimeType"
						:file-size="file.fileSize"
						:created-at="file.createdAt"
						:source-type="file.sourceType"
					/>

					<!-- Tags -->
					<FilesDetailTagsCard
						:file-id="fileId"
						:tags="file.tags"
						:auto-tags="file.autoTags"
						:is-admin="isAdmin"
					/>

					<!-- Linked contacts -->
					<FilesDetailContactsCard
						:file-id="fileId"
						:contact-ids="file.contactIds"
						:is-admin="isAdmin"
					/>

					<!-- Linked conversation -->
					<FilesDetailThreadCard
						:file-id="fileId"
						:thread-id="file.threadId"
						:thread-subject="file.threadSubject"
						:is-admin="isAdmin"
					/>
				</div>
			</div>
		</template>

		<!-- Upload new version -->
		<FilesFileUploadModal
			:open="showVersionUpload"
			:previous-version-id="fileId"
			@update:open="showVersionUpload = $event"
			@uploaded="handleVersionUploaded"
		/>

		<!-- Delete confirmation -->
		<UiConfirmationDialog
			:open="showDeleteConfirm"
			variant="danger"
			:title="t('dashboard.files.detail.deleteDialog.title')"
			:description="t('dashboard.files.detail.deleteDialog.description')"
			:confirm-text="t('common.delete')"
			:is-loading="isDeleting"
			@update:open="showDeleteConfirm = $event"
			@confirm="handleDelete"
		/>
	</div>
</template>
