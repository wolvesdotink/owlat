<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import { ImageUp, ImageIcon } from '@lucide/vue';
import { EmailBuilderHandlersKey } from '../../../composables/useEmailBuilderHandlers';

const props = defineProps<{
	value: string;
	onUploadImage?: (file: File) => Promise<{ url: string; storageId?: string }>;
}>();

// Inject handlers to get pickFromMediaLibrary without prop drilling
const handlers = inject(EmailBuilderHandlersKey, undefined);
const hasMediaLibrary = computed(() => !!handlers?.pickFromMediaLibrary);

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();

const fileInputRef = ref<HTMLInputElement | null>(null);
const isUploading = ref(false);
const uploadError = ref('');

function handleBrowse() {
	if (!handlers?.pickFromMediaLibrary) return;
	// Callback-based: the edit page will call onSelect when the user picks an image.
	// This doesn't require the component to stay mounted.
	handlers.pickFromMediaLibrary((result) => {
		emit('update', result.url);
	});
}

const hasPreview = computed(() => {
	return props.value && (props.value.startsWith('http') || props.value.startsWith('data:'));
});

function handleTextInput(event: Event) {
	emit('update', (event.target as HTMLInputElement).value);
}

function openFilePicker() {
	fileInputRef.value?.click();
}

async function handleFileSelect(event: Event) {
	const file = (event.target as HTMLInputElement).files?.[0];
	if (!file || !props.onUploadImage) return;
	isUploading.value = true;
	uploadError.value = '';
	try {
		const result = await props.onUploadImage(file);
		emit('update', result.url);
	} catch (error) {
		uploadError.value = error instanceof Error ? error.message : 'Upload failed';
	} finally {
		isUploading.value = false;
	}
}
</script>

<template>
	<div class="flex flex-col gap-1.5">
		<!-- Thumbnail preview -->
		<div v-if="hasPreview" class="relative w-full h-16 border border-border-subtle rounded-lg overflow-hidden bg-checker">
			<img :src="value" alt="" class="w-full h-full object-contain" />
		</div>

		<!-- URL + browse row -->
		<div class="flex gap-1">
			<input
				type="text"
				class="flex-1 py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring"
				:value="value"
				placeholder="Image URL"
				@input="handleTextInput"
			/>
			<button
				v-if="hasMediaLibrary"
				class="flex items-center gap-1 py-2 px-2.5 text-xs font-medium border border-border-subtle rounded-lg bg-bg-surface text-text-secondary cursor-pointer whitespace-nowrap transition-all duration-150 hover:not-disabled:bg-bg-overlay hover:not-disabled:text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
				type="button"
				title="Browse or upload images"
				@click="handleBrowse"
			>
				<ImageUp :size="14" />
			</button>
			<button
				v-else-if="onUploadImage"
				class="flex items-center gap-1 py-2 px-2.5 text-xs font-medium border border-border-subtle rounded-lg bg-bg-surface text-text-secondary cursor-pointer whitespace-nowrap transition-all duration-150 hover:not-disabled:bg-bg-overlay hover:not-disabled:text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
				type="button"
				:disabled="isUploading"
				@click="openFilePicker"
			>
				<ImageUp :size="14" />
			</button>
			<input
				ref="fileInputRef"
				type="file"
				class="hidden"
				accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
				@change="handleFileSelect"
			/>
		</div>

		<!-- Upload error -->
		<div v-if="uploadError" class="flex items-center gap-1.5 p-2 border border-red-300 rounded-lg bg-red-50 text-red-700 text-xs">
			<span>{{ uploadError }}</span>
		</div>

		<!-- Drop zone hint -->
		<div v-if="!hasPreview" class="flex items-center justify-center gap-1.5 p-3 border border-dashed border-border-subtle rounded-lg text-text-disabled text-xs">
			<ImageIcon :size="16" />
			<span>Paste URL or upload</span>
		</div>
	</div>
</template>
