<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { data: files, isLoading } = useConvexQuery(
	api.semanticFiles.listByContact,
	() => ({ contactId: props.contactId, limit: 50 }),
);

const mimeIcon = (mimeType: string): string => {
	if (mimeType.startsWith('image/')) return 'lucide:image';
	if (mimeType === 'application/pdf') return 'lucide:file-text';
	if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return 'lucide:table';
	if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'lucide:presentation';
	if (mimeType.includes('word') || mimeType.includes('document')) return 'lucide:file-text';
	if (mimeType.startsWith('text/')) return 'lucide:file-text';
	if (mimeType.startsWith('video/')) return 'lucide:video';
	if (mimeType.startsWith('audio/')) return 'lucide:music';
	if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) return 'lucide:archive';
	return 'lucide:file';
};


const sourceLabel = (sourceType: string): string => {
	const map: Record<string, string> = {
		upload: 'Uploaded',
		email_attachment: 'Email Attachment',
		agent_generated: 'AI Generated',
	};
	return map[sourceType] || sourceType;
};

const sourceIcon = (sourceType: string): string => {
	const map: Record<string, string> = {
		upload: 'lucide:upload',
		email_attachment: 'lucide:paperclip',
		agent_generated: 'lucide:bot',
	};
	return map[sourceType] || 'lucide:file';
};
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-medium text-text-primary">Files</h2>
			<span v-if="files" class="text-xs text-text-tertiary">
				{{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}
			</span>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<div class="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-tertiary text-sm">Loading files...</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="!files || files.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox icon="lucide:file-search" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">No files linked to this contact</p>
			<p class="text-text-tertiary text-sm mt-1">
				Files from email attachments and uploads will appear here.
			</p>
		</div>

		<!-- File list -->
		<div v-else class="space-y-2">
			<NuxtLink
				v-for="file in files"
				:key="file._id"
				:to="`/dashboard/files/${file._id}`"
				class="flex items-center gap-3 p-3 rounded-lg bg-bg-surface hover:bg-bg-surface/80 border border-border-subtle hover:border-brand/30 transition-colors"
			>
				<!-- File icon -->
				<div class="flex-shrink-0 p-2 rounded-lg bg-bg-elevated">
					<Icon :name="mimeIcon(file.mimeType)" class="w-5 h-5 text-text-tertiary" />
				</div>

				<!-- File info -->
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium text-text-primary truncate">
						{{ file.title || file.filename }}
					</p>
					<div class="flex items-center gap-2 mt-0.5">
						<span class="text-xs text-text-tertiary">{{ formatCompactFileSize(file.fileSize) }}</span>
						<span class="text-xs text-text-tertiary">·</span>
						<span class="text-xs text-text-tertiary">{{ formatDate(file.createdAt) }}</span>
					</div>
				</div>

				<!-- Source badge -->
				<div class="flex-shrink-0 flex items-center gap-1.5">
					<Icon :name="sourceIcon(file.sourceType)" class="w-3 h-3 text-text-tertiary" />
					<span class="text-xs text-text-tertiary">{{ sourceLabel(file.sourceType) }}</span>
				</div>

				<!-- Tags -->
				<div class="hidden sm:flex items-center gap-1">
					<span
						v-for="tag in (file.tags || file.autoTags || []).slice(0, 2)"
						:key="tag"
						class="inline-block px-1.5 py-0.5 rounded text-[10px] bg-bg-elevated text-text-tertiary"
					>
						{{ tag }}
					</span>
				</div>
			</NuxtLink>
		</div>
	</div>
</template>
