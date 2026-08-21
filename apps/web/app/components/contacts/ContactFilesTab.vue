<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { t } = useI18n();

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
		upload: 'components.contacts.contactFilesTab.sources.upload',
		email_attachment: 'components.contacts.contactFilesTab.sources.emailAttachment',
		agent_generated: 'components.contacts.contactFilesTab.sources.agentGenerated',
	};
	const key = map[sourceType];
	return key ? t(key) : sourceType;
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
			<h2 class="text-lg font-medium text-text-primary">
				{{ t('components.contacts.contactFilesTab.title') }}
			</h2>
			<span v-if="files" class="text-xs text-text-tertiary">
				{{
					t(
						'components.contacts.contactFilesTab.count',
						{ count: files.length },
						files.length,
					)
				}}
			</span>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">
					{{ t('components.contacts.contactFilesTab.loading') }}
				</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="!files || files.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox icon="lucide:file-search" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">
				{{ t('components.contacts.contactFilesTab.emptyTitle') }}
			</p>
			<p class="text-text-tertiary text-sm mt-1">
				{{ t('components.contacts.contactFilesTab.emptyBody') }}
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
