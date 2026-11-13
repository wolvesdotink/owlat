<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { FileIcon } from '@coolicons/vue';

interface Attachment {
	_id: Id<'mediaAssets'>;
	filename: string;
	mimeType: string;
	fileSize: number;
	width: number | null;
	height: number | null;
	url: string;
}

interface Props {
	attachment: Attachment;
}

const props = defineProps<Props>();

const isImage = computed(() => props.attachment.mimeType.startsWith('image/'));

// The upload probed the image's size, so the row can reserve its box before
// the image loads and the message list does not jump when it arrives.
const imageBox = computed(() => {
	const { width, height } = props.attachment;
	if (!width || !height) return undefined;
	return { width, height };
});
</script>

<template>
	<a
		v-if="isImage"
		:href="attachment.url"
		target="_blank"
		rel="noopener noreferrer"
		class="block border border-border-subtle rounded-lg overflow-hidden hover:border-brand transition-colors"
	>
		<img
			:src="attachment.url"
			:alt="attachment.filename"
			:width="imageBox?.width"
			:height="imageBox?.height"
			class="max-w-xs max-h-64 object-cover"
		/>
	</a>
	<a
		v-else
		:href="attachment.url"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-2 px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg hover:border-brand transition-colors"
	>
		<FileIcon class="w-4 h-4 text-text-tertiary" />
		<div class="flex flex-col text-xs">
			<span
				class="text-text-primary font-medium truncate max-w-[200px]"
				:title="attachment.filename"
			>
				{{ attachment.filename }}
			</span>
			<span class="text-text-tertiary">{{ formatCompactFileSize(attachment.fileSize) }}</span>
		</div>
	</a>
</template>
