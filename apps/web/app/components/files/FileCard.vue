<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import {
	ArchiveIcon,
	FileIcon,
	FileTextIcon,
	FilmIcon,
	ImageIcon,
	MailIcon,
	MusicNoteIcon,
	PresentationIcon,
	SparklesIcon,
	TableIcon,
	UploadIcon,
} from '@coolicons/vue';

const props = defineProps<{
	id: Id<'semanticFiles'>;
	filename: string;
	title?: string | null;
	mimeType: string;
	fileSize: number;
	tags?: string[];
	autoTags?: string[];
	sourceType: 'upload' | 'email_attachment' | 'agent_generated';
	createdAt: number;
}>();

const { t } = useI18n();
const mimeIcon = computed(() => {
	const mime = props.mimeType;
	if (mime === 'application/pdf') return FileTextIcon;
	if (mime.startsWith('image/')) return ImageIcon;
	if (mime.startsWith('video/')) return FilmIcon;
	if (mime.startsWith('audio/')) return MusicNoteIcon;
	if (mime.includes('spreadsheet') || mime.includes('csv') || mime.includes('excel'))
		return TableIcon;
	if (mime.includes('presentation') || mime.includes('powerpoint')) return PresentationIcon;
	if (mime.includes('word') || mime.includes('document')) return FileTextIcon;
	if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed'))
		return ArchiveIcon;
	if (mime.startsWith('text/')) return FileTextIcon;
	return FileIcon;
});

const sourceLabel = computed(() => {
	switch (props.sourceType) {
		case 'upload':
			return t('components.files.fileCard.sources.upload');
		case 'email_attachment':
			return t('components.files.fileCard.sources.email_attachment');
		case 'agent_generated':
			return t('components.files.fileCard.sources.agent_generated');
		default:
			return props.sourceType;
	}
});

const sourceVariant = computed(() => {
	switch (props.sourceType) {
		case 'upload':
			return 'default';
		case 'email_attachment':
			return 'info';
		case 'agent_generated':
			return 'brand';
		default:
			return 'default';
	}
});

const displayTags = computed(() => {
	const all = [...(props.tags || []), ...(props.autoTags || [])];
	return [...new Set(all)].slice(0, 4);
});
</script>

<template>
	<!-- A link, not a clickable div: reachable by keyboard and openable in a
	     new tab like every other row that leads somewhere. -->
	<NuxtLink
		:to="`/dashboard/files/${id}`"
		class="group block bg-bg-elevated shadow-surface-1 rounded-(--radius-card) overflow-hidden transition-shadow duration-(--motion-moderate) hover:shadow-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
	>
		<!-- Icon area -->
		<div class="flex items-center justify-center py-8 bg-bg-surface">
			<component
				:is="mimeIcon"
				class="w-10 h-10 text-text-tertiary group-hover:text-text-secondary transition-colors"
				:stroke-width="1.5"
			/>
		</div>

		<!-- Info -->
		<div class="px-4 py-3 space-y-2">
			<p class="text-sm font-medium text-text-primary truncate" :title="title || filename">
				{{ title || filename }}
			</p>

			<div class="flex items-center gap-2 text-xs text-text-tertiary">
				<span>{{ formatCompactFileSize(fileSize) }}</span>
				<span>&middot;</span>
				<span>{{ formatDate(createdAt) }}</span>
			</div>

			<!-- Tags -->
			<div v-if="displayTags.length > 0" class="flex flex-wrap gap-1">
				<span
					v-for="tag in displayTags"
					:key="tag"
					class="inline-flex items-center px-1.5 py-0.5 text-2xs font-medium rounded bg-bg-surface text-text-secondary"
				>
					{{ tag }}
				</span>
			</div>

			<!-- Source badge -->
			<div class="flex items-center justify-between">
				<span
					class="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-full"
					:class="{
						'bg-bg-surface text-text-secondary': sourceType === 'upload',
						'bg-info-subtle text-info': sourceType === 'email_attachment',
						'bg-brand-subtle text-brand': sourceType === 'agent_generated',
					}"
				>
					<component
						:is="
							sourceType === 'upload'
								? UploadIcon
								: sourceType === 'email_attachment'
									? MailIcon
									: SparklesIcon
						"
						class="w-3 h-3"
					/>
					{{ sourceLabel }}
				</span>
			</div>
		</div>
	</NuxtLink>
</template>
