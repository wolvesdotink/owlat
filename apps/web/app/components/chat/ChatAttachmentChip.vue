<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

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
		<Icon name="lucide:file" class="w-4 h-4 text-text-tertiary" />
		<div class="flex flex-col text-xs">
			<span class="text-text-primary font-medium truncate max-w-[200px]">
				{{ attachment.filename }}
			</span>
			<span class="text-text-tertiary">{{ formatCompactFileSize(attachment.fileSize) }}</span>
		</div>
	</a>
</template>
