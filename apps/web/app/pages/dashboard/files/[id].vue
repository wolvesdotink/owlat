<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'File Details — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const { showToast } = useToast();

// Editing, deleting and uploading new versions of files is admin-only on the
// backend (semanticFiles mutations call requireAdminContext), so hide those
// affordances for non-admin members.
const { isAdmin } = usePermissions();

const fileId = computed(() => route.params['id'] as Id<'semanticFiles'>);

// File data
const { data: file, isLoading } = useConvexQuery(
	api.semanticFiles.get,
	() => ({ fileId: fileId.value }),
);

// Version history
const { data: versions } = useConvexQuery(
	api.semanticFiles.getVersionHistory,
	() => ({ fileId: fileId.value }),
);

// Mutations
const { run: updateFile } = useBackendOperation(api.semanticFiles.update, {
	label: 'Update file',
});
const { run: removeFile } = useBackendOperation(api.semanticFiles.remove, {
	label: 'Delete file',
});

// Edit state
const isEditingTags = ref(false);
const editTagsInput = ref('');
const isEditingTitle = ref(false);
const editTitleInput = ref('');
const isEditingContacts = ref(false);
const editContacts = ref<PickerContact[]>([]);

// Hydrate the file's linked contact ids into full rows so the editable picker
// can render labels/chips (the file row carries only ids).
const linkedContactIds = computed(() => file.value?.contactIds ?? []);
const { data: linkedContacts } = useConvexQuery(
	api.contacts.contacts.getByIds,
	() => ({ contactIds: linkedContactIds.value }),
);

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
const showVersions = ref(true);

const startEditTags = () => {
	editTagsInput.value = (file.value?.tags || []).join(', ');
	isEditingTags.value = true;
};

const saveTags = async () => {
	if (!file.value) return;
	const tags = editTagsInput.value
		.split(',')
		.map((t: string) => t.trim())
		.filter(Boolean);
	const result = await updateFile({ fileId: fileId.value, tags });
	if (result === undefined) return;
	isEditingTags.value = false;
	showToast('Tags updated');
};

const cancelEditTags = () => {
	isEditingTags.value = false;
};

const startEditTitle = () => {
	editTitleInput.value = file.value?.title || '';
	isEditingTitle.value = true;
};

const saveTitle = async () => {
	if (!file.value) return;
	const result = await updateFile({ fileId: fileId.value, title: editTitleInput.value || undefined });
	if (result === undefined) return;
	isEditingTitle.value = false;
	showToast('Title updated');
};

const cancelEditTitle = () => {
	isEditingTitle.value = false;
};

const startEditContacts = () => {
	editContacts.value = [...(linkedContacts.value ?? [])];
	isEditingContacts.value = true;
};

const saveContacts = async () => {
	if (!file.value) return;
	const contactIds = editContacts.value.map((c) => c._id);
	const result = await updateFile({ fileId: fileId.value, contactIds });
	if (result === undefined) return;
	isEditingContacts.value = false;
	showToast('Linked contacts updated');
};

const cancelEditContacts = () => {
	isEditingContacts.value = false;
};

const handleDelete = async () => {
	isDeleting.value = true;
	try {
		const result = await removeFile({ fileId: fileId.value });
		if (result === undefined) return;
		showToast('File deleted');
		router.push('/dashboard/files');
	} finally {
		isDeleting.value = false;
	}
};

// Helpers

const mimeIcon = computed(() => {
	if (!file.value) return 'lucide:file';
	const mime = file.value.mimeType;
	if (mime === 'application/pdf') return 'lucide:file-text';
	if (mime.startsWith('image/')) return 'lucide:image';
	if (mime.startsWith('video/')) return 'lucide:film';
	if (mime.startsWith('audio/')) return 'lucide:music';
	if (mime.includes('spreadsheet') || mime.includes('csv')) return 'lucide:table';
	if (mime.includes('word') || mime.includes('document')) return 'lucide:file-text';
	if (mime.startsWith('text/')) return 'lucide:file-type';
	return 'lucide:file';
});

const sourceLabel = computed(() => {
	if (!file.value) return '';
	switch (file.value.sourceType) {
		case 'upload': return 'Manual Upload';
		case 'email_attachment': return 'Email Attachment';
		case 'agent_generated': return 'AI Generated';
		default: return file.value.sourceType;
	}
});
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl">
		<!-- Back link -->
		<NuxtLink
			to="/dashboard/files"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Files
		</NuxtLink>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading file...</p>
			</div>
		</div>

		<!-- Not found -->
		<div v-else-if="!file" class="flex flex-col items-center justify-center py-16 text-center">
			<UiIconBox icon="lucide:file-x" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">File not found</p>
			<NuxtLink to="/dashboard/files" class="text-sm text-brand hover:underline mt-2">
				Return to Files
			</NuxtLink>
		</div>

		<!-- File detail -->
		<template v-else>
			<!-- Header -->
			<div class="flex items-start justify-between gap-4 mb-8">
				<div class="flex items-start gap-4 min-w-0">
					<div class="flex-shrink-0 w-14 h-14 rounded-xl bg-bg-surface border border-border-subtle flex items-center justify-center">
						<Icon :name="mimeIcon" class="w-7 h-7 text-text-tertiary" />
					</div>
					<div class="min-w-0">
						<!-- Title -->
						<div v-if="isEditingTitle" class="flex items-center gap-2">
							<input
								v-model="editTitleInput"
								type="text"
								class="rounded-lg border border-border-subtle bg-bg-base px-3 py-1.5 text-lg font-semibold text-text-primary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
								placeholder="File title..."
								@keyup.enter="saveTitle"
								@keyup.escape="cancelEditTitle"
							/>
							<button class="p-1 rounded text-brand hover:bg-brand-subtle transition-colors" @click="saveTitle" aria-label="Confirm">
								<Icon name="lucide:check" class="w-4 h-4" />
							</button>
							<button class="p-1 rounded text-text-tertiary hover:bg-bg-surface transition-colors" @click="cancelEditTitle" aria-label="Close">
								<Icon name="lucide:x" class="w-4 h-4" />
							</button>
						</div>
						<h1
							v-else
							class="text-xl font-semibold text-text-primary group"
							:class="{ 'cursor-pointer': isAdmin }"
							@click="isAdmin && startEditTitle()"
						>
							{{ file.title || file.filename }}
							<Icon v-if="isAdmin" name="lucide:pencil" class="w-3.5 h-3.5 text-text-tertiary inline-block opacity-0 group-hover:opacity-100 transition-opacity ml-1" />
						</h1>
						<p class="text-sm text-text-secondary mt-0.5">{{ file.filename }}</p>
					</div>
				</div>

				<div class="flex items-center gap-2 flex-shrink-0">
					<a
						v-if="file.url"
						:href="file.url"
						target="_blank"
						rel="noopener noreferrer"
						class="btn btn-secondary"
					>
						<Icon name="lucide:download" class="w-4 h-4 mr-2" />
						Download
					</a>
					<button
						v-if="isAdmin"
						class="btn btn-secondary"
						@click="showVersionUpload = true"
					>
						<Icon name="lucide:upload" class="w-4 h-4 mr-2" />
						New Version
					</button>
					<button
						v-if="isAdmin"
						class="btn border border-error/30 text-error hover:bg-error-subtle transition-colors"
						@click="showDeleteConfirm = true"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4 mr-2" />
						Delete
					</button>
				</div>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main content -->
				<div class="lg:col-span-2 space-y-6">
					<!-- AI Summary -->
					<div v-if="file.summary" class="bg-bg-elevated border border-border-subtle rounded-lg">
						<button
							class="w-full flex items-center justify-between px-5 py-4"
							@click="showSummary = !showSummary"
						>
							<div class="flex items-center gap-2">
								<Icon name="lucide:sparkles" class="w-4 h-4 text-brand" />
								<span class="text-sm font-medium text-text-primary">AI Summary</span>
							</div>
							<Icon
								name="lucide:chevron-down"
								class="w-4 h-4 text-text-tertiary transition-transform"
								:class="{ '-rotate-180': showSummary }"
							/>
						</button>
						<div v-if="showSummary" class="px-5 pb-4">
							<p class="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{{ file.summary }}</p>
						</div>
					</div>

					<!-- Extracted text -->
					<div v-if="file.extractedText" class="bg-bg-elevated border border-border-subtle rounded-lg">
						<button
							class="w-full flex items-center justify-between px-5 py-4"
							@click="showExtractedText = !showExtractedText"
						>
							<div class="flex items-center gap-2">
								<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
								<span class="text-sm font-medium text-text-primary">Extracted Text</span>
							</div>
							<Icon
								name="lucide:chevron-down"
								class="w-4 h-4 text-text-tertiary transition-transform"
								:class="{ '-rotate-180': showExtractedText }"
							/>
						</button>
						<div v-if="showExtractedText" class="px-5 pb-4">
							<pre class="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap font-mono bg-bg-surface rounded-lg p-4 max-h-96 overflow-y-auto">{{ file.extractedText }}</pre>
						</div>
					</div>

					<!-- Version history -->
					<div class="bg-bg-elevated border border-border-subtle rounded-lg">
						<button
							class="w-full flex items-center justify-between px-5 py-4"
							@click="showVersions = !showVersions"
						>
							<div class="flex items-center gap-2">
								<Icon name="lucide:history" class="w-4 h-4 text-text-tertiary" />
								<span class="text-sm font-medium text-text-primary">Version History</span>
								<span v-if="versions" class="text-xs text-text-tertiary">({{ versions.length }})</span>
							</div>
							<Icon
								name="lucide:chevron-down"
								class="w-4 h-4 text-text-tertiary transition-transform"
								:class="{ '-rotate-180': showVersions }"
							/>
						</button>
						<div v-if="showVersions" class="px-5 pb-4">
							<FilesVersionHistory
								:versions="versions || []"
								:current-version-id="file._id"
							/>
						</div>
					</div>
				</div>

				<!-- Sidebar metadata -->
				<div class="space-y-6">
					<!-- File info -->
					<div class="bg-bg-elevated border border-border-subtle rounded-lg p-5 space-y-4">
						<h3 class="text-sm font-semibold text-text-primary">Details</h3>

						<div class="space-y-3">
							<div>
								<p class="text-xs text-text-tertiary mb-0.5">MIME Type</p>
								<p class="text-sm text-text-secondary">{{ file.mimeType }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary mb-0.5">File Size</p>
								<p class="text-sm text-text-secondary">{{ formatCompactFileSize(file.fileSize) }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary mb-0.5">Created</p>
								<p class="text-sm text-text-secondary">{{ formatDateTime(file.createdAt) }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary mb-0.5">Source</p>
								<span
									class="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-full"
									:class="{
										'bg-bg-surface text-text-secondary': file.sourceType === 'upload',
										'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300': file.sourceType === 'email_attachment',
										'bg-brand-subtle text-brand': file.sourceType === 'agent_generated',
									}"
								>
									<Icon
										:name="file.sourceType === 'upload' ? 'lucide:upload'
											: file.sourceType === 'email_attachment' ? 'lucide:mail'
											: 'lucide:sparkles'"
										class="w-3.5 h-3.5"
									/>
									{{ sourceLabel }}
								</span>
							</div>
							<div v-if="file.threadId">
								<p class="text-xs text-text-tertiary mb-0.5">Linked Thread</p>
								<NuxtLink
									:to="`/dashboard/inbox/${file.threadId}`"
									class="text-sm text-brand hover:underline"
								>
									View conversation
								</NuxtLink>
							</div>
						</div>
					</div>

					<!-- Tags -->
					<div class="bg-bg-elevated border border-border-subtle rounded-lg p-5">
						<div class="flex items-center justify-between mb-3">
							<h3 class="text-sm font-semibold text-text-primary">Tags</h3>
							<button
								v-if="!isEditingTags && isAdmin"
								class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								@click="startEditTags"
							 aria-label="Edit">
								<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
							</button>
						</div>

						<div v-if="isEditingTags" class="space-y-3">
							<input
								v-model="editTagsInput"
								type="text"
								class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
								placeholder="tag1, tag2, tag3..."
								@keyup.enter="saveTags"
							/>
							<div class="flex items-center gap-2">
								<button
									class="text-xs text-brand font-medium hover:underline"
									@click="saveTags"
								>
									Save
								</button>
								<button
									class="text-xs text-text-tertiary hover:text-text-primary"
									@click="cancelEditTags"
								>
									Cancel
								</button>
							</div>
						</div>

						<div v-else>
							<div v-if="file.tags && file.tags.length > 0" class="flex flex-wrap gap-1.5">
								<span
									v-for="tag in file.tags"
									:key="tag"
									class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
								>
									{{ tag }}
								</span>
							</div>
							<p v-else class="text-sm text-text-tertiary">No tags</p>

							<!-- Auto tags -->
							<div v-if="file.autoTags && file.autoTags.length > 0" class="mt-3">
								<p class="text-xs text-text-tertiary mb-1.5">Auto-detected</p>
								<div class="flex flex-wrap gap-1.5">
									<span
										v-for="tag in file.autoTags"
										:key="tag"
										class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-brand-subtle/50 text-brand"
									>
										<Icon name="lucide:sparkles" class="w-3 h-3" />
										{{ tag }}
									</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Linked contacts -->
					<div class="bg-bg-elevated border border-border-subtle rounded-lg p-5">
						<div class="flex items-center justify-between mb-3">
							<h3 class="text-sm font-semibold text-text-primary">Linked Contacts</h3>
							<button
								v-if="!isEditingContacts && isAdmin"
								class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								aria-label="Edit linked contacts"
								@click="startEditContacts"
							>
								<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
							</button>
						</div>

						<!-- Edit: multi-select contact picker -->
						<div v-if="isEditingContacts" class="space-y-3">
							<FilesContactPicker v-model="editContacts" />
							<div class="flex items-center gap-2">
								<button class="text-xs text-brand font-medium hover:underline" @click="saveContacts">
									Save
								</button>
								<button class="text-xs text-text-tertiary hover:text-text-primary" @click="cancelEditContacts">
									Cancel
								</button>
							</div>
						</div>

						<!-- Read: linked contacts as links -->
						<div v-else>
							<div v-if="linkedContacts && linkedContacts.length > 0" class="space-y-2">
								<NuxtLink
									v-for="contact in linkedContacts"
									:key="contact._id"
									:to="`/dashboard/audience/contacts/${contact._id}`"
									class="flex items-center gap-2 p-2 -mx-2 rounded-lg hover:bg-bg-surface transition-colors"
								>
									<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
									<span class="text-sm text-brand hover:underline truncate">{{ contactPickerLabel(contact) }}</span>
								</NuxtLink>
							</div>
							<p v-else class="text-sm text-text-tertiary">No linked contacts</p>
						</div>
					</div>
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
		<Teleport to="body">
			<Transition
				enter-active-class="duration-200 ease-out"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-150 ease-in"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<div class="absolute inset-0 bg-black/60" @click="showDeleteConfirm = false" />
					<div class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-sm">
						<h3 class="text-lg font-semibold text-text-primary mb-2">Delete File</h3>
						<p class="text-sm text-text-secondary mb-6">
							This will permanently delete this file and all its version history. This action cannot be undone.
						</p>
						<div class="flex items-center justify-end gap-3">
							<button class="btn btn-secondary" @click="showDeleteConfirm = false">Cancel</button>
							<button
								class="btn bg-error text-white hover:bg-error/90"
								:disabled="isDeleting"
								@click="handleDelete"
							>
								{{ isDeleting ? 'Deleting...' : 'Delete' }}
							</button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
