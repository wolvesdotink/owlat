<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';

const props = defineProps<{
	open: boolean;
	// When set, the upload is registered as a new version of this file (the
	// backend computes version = prev.version + 1 and a changeSummary diff)
	// rather than a fresh file.
	previousVersionId?: Id<'semanticFiles'>;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'uploaded', fileId: Id<'semanticFiles'>): void;
}>();

const isNewVersion = computed(() => Boolean(props.previousVersionId));

const { upload, isUploading } = useSemanticFiles();

// Form state
const selectedFile = ref<File | null>(null);
const title = ref('');
const tagsInput = ref('');
const sourceType = ref<'upload' | 'email_attachment' | 'agent_generated'>('upload');
// Contacts this file is about — associates the upload with people so it shows
// on their Files tab and in the file's Linked Contacts panel.
const selectedContacts = ref<PickerContact[]>([]);

// Drag state (shared drop-zone primitive). On desktop, also accept OS-level
// file drops from Finder/Explorer, scoped to the drop-zone element.
const fileInputRef = ref<HTMLInputElement | null>(null);
const dropZoneRef = ref<HTMLElement | null>(null);
const onFilesPicked = (files: File[]) => {
	if (files.length) {
		selectedFile.value = files[0]!;
	}
};
const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDropZone(onFilesPicked, {
	osFileDrop: true,
	rootRef: dropZoneRef,
});

// Click-to-browse: the native OS picker on desktop, the HTML input on web.
const { isDesktop, pickNativeFiles } = useNativeFilePicker();
const browse = async () => {
	if (isDesktop.value) {
		onFilesPicked(await pickNativeFiles({ title: 'Choose a file' }));
		return;
	}
	fileInputRef.value?.click();
};

const parsedTags = computed(() => {
	return tagsInput.value
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
});

const handleFileSelect = (event: Event) => {
	const input = event.target as HTMLInputElement;
	if (input.files?.length) {
		selectedFile.value = input.files[0]!;
	}
};

const removeSelectedFile = () => {
	selectedFile.value = null;
	if (fileInputRef.value) {
		fileInputRef.value.value = '';
	}
};

const close = () => {
	emit('update:open', false);
};

const resetForm = () => {
	selectedFile.value = null;
	title.value = '';
	tagsInput.value = '';
	sourceType.value = 'upload';
	selectedContacts.value = [];
	if (fileInputRef.value) {
		fileInputRef.value.value = '';
	}
};

const handleSubmit = async () => {
	if (!selectedFile.value) return;

	const contactIds = selectedContacts.value.map((c) => c._id);
	const fileId = await upload(selectedFile.value, {
		title: title.value || undefined,
		tags: parsedTags.value.length > 0 ? parsedTags.value : undefined,
		sourceType: sourceType.value,
		contactIds: contactIds.length > 0 ? contactIds : undefined,
		previousVersionId: props.previousVersionId,
	});
	if (fileId === undefined) return;
	resetForm();
	emit('uploaded', fileId);
	close();
};

// Reset form when modal opens
watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			resetForm();
		}
	}
);
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
				<div class="absolute inset-0 bg-black/60" @click="close" />
				<div
					class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-lg"
				>
					<!-- Header -->
					<div class="flex items-center justify-between mb-6">
						<h3 class="text-lg font-semibold text-text-primary">
							{{ isNewVersion ? 'Upload New Version' : 'Upload File' }}
						</h3>
						<button
							class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
							@click="close"
							aria-label="Close"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</div>

					<!-- New-version hint -->
					<div
						v-if="isNewVersion"
						class="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-lg bg-brand-subtle/50 text-text-secondary"
					>
						<Icon name="lucide:history" class="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
						<p class="text-xs leading-relaxed">
							This file will be added as a new version. The previous version stays in the version
							history.
						</p>
					</div>

					<!-- Drop zone -->
					<div
						v-if="!selectedFile"
						ref="dropZoneRef"
						class="border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer"
						:class="
							isDragOver
								? 'border-brand bg-brand-subtle/50'
								: 'border-border-subtle hover:border-border-default'
						"
						@dragover="handleDragOver"
						@dragleave="handleDragLeave"
						@drop="handleDrop"
						@click="browse"
					>
						<Icon name="lucide:upload-cloud" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
						<p class="text-sm font-medium text-text-primary">Drop a file here or click to browse</p>
						<p class="text-xs text-text-tertiary mt-1">
							Any file type up to {{ MAX_LIBRARY_FILE_MB }} MB
						</p>
					</div>

					<!-- Selected file preview -->
					<div
						v-else
						class="flex items-center gap-3 p-4 bg-bg-surface border border-border-subtle rounded-xl"
					>
						<Icon name="lucide:file" class="w-8 h-8 text-text-tertiary flex-shrink-0" />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-text-primary truncate">{{ selectedFile.name }}</p>
							<p class="text-xs text-text-tertiary">
								{{ formatCompactFileSize(selectedFile.size) }}
							</p>
						</div>
						<button
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors flex-shrink-0"
							@click="removeSelectedFile"
							aria-label="Remove file"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
						</button>
					</div>

					<input ref="fileInputRef" type="file" class="hidden" @change="handleFileSelect" />

					<!-- Form fields -->
					<div class="mt-5 space-y-4">
						<div>
							<label for="title" class="block text-sm font-medium text-text-primary mb-1.5"
								>Title (optional)</label
							>
							<input
								id="title"
								v-model="title"
								type="text"
								class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
								placeholder="Give this file a descriptive title..."
							/>
						</div>

						<div>
							<label for="tagsinput" class="block text-sm font-medium text-text-primary mb-1.5"
								>Tags (optional)</label
							>
							<input
								id="tagsinput"
								v-model="tagsInput"
								type="text"
								class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
								placeholder="invoice, report, Q1 (comma-separated)"
							/>
							<div v-if="parsedTags.length > 0" class="flex flex-wrap gap-1.5 mt-2">
								<span
									v-for="tag in parsedTags"
									:key="tag"
									class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
								>
									{{ tag }}
								</span>
							</div>
						</div>

						<div>
							<label for="sourcetype" class="block text-sm font-medium text-text-primary mb-1.5"
								>Source</label
							>
							<select
								id="sourcetype"
								v-model="sourceType"
								class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
							>
								<option value="upload">Manual Upload</option>
								<option value="email_attachment">Email Attachment</option>
								<option value="agent_generated">AI Generated</option>
							</select>
						</div>

						<div>
							<label class="block text-sm font-medium text-text-primary mb-1.5"
								>Linked contacts (optional)</label
							>
							<FilesContactPicker v-model="selectedContacts" />
						</div>
					</div>

					<!-- Footer -->
					<div class="flex items-center justify-end gap-3 mt-6">
						<button class="btn btn-secondary" @click="close">Cancel</button>
						<button
							class="btn bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
							:disabled="!selectedFile || isUploading"
							@click="handleSubmit"
						>
							<template v-if="isUploading">
								<div
									class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"
								/>
								Uploading...
							</template>
							<template v-else>
								{{ isNewVersion ? 'Upload Version' : 'Upload' }}
							</template>
						</button>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
