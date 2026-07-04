<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

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

const router = useRouter();

const navigate = () => {
	router.push(`/dashboard/files/${props.id}`);
};

const mimeIcon = computed(() => {
	const mime = props.mimeType;
	if (mime === 'application/pdf') return 'lucide:file-text';
	if (mime.startsWith('image/')) return 'lucide:image';
	if (mime.startsWith('video/')) return 'lucide:film';
	if (mime.startsWith('audio/')) return 'lucide:music';
	if (mime.includes('spreadsheet') || mime.includes('csv') || mime.includes('excel'))
		return 'lucide:table';
	if (mime.includes('presentation') || mime.includes('powerpoint')) return 'lucide:presentation';
	if (mime.includes('word') || mime.includes('document')) return 'lucide:file-text';
	if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed'))
		return 'lucide:file-archive';
	if (mime.startsWith('text/')) return 'lucide:file-type';
	return 'lucide:file';
});

const sourceLabel = computed(() => {
	switch (props.sourceType) {
		case 'upload':
			return 'Upload';
		case 'email_attachment':
			return 'Email';
		case 'agent_generated':
			return 'AI';
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
	<div
		class="group bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden cursor-pointer transition-all duration-(--motion-moderate) hover:border-border-default hover:shadow-sm"
		@click="navigate"
	>
		<!-- Icon area -->
		<div class="flex items-center justify-center py-8 bg-bg-surface">
			<Icon
				:name="mimeIcon"
				class="w-10 h-10 text-text-tertiary group-hover:text-text-secondary transition-colors"
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
					class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-bg-surface text-text-secondary"
				>
					{{ tag }}
				</span>
			</div>

			<!-- Source badge -->
			<div class="flex items-center justify-between">
				<span
					class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full"
					:class="{
						'bg-bg-surface text-text-secondary': sourceType === 'upload',
						'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300':
							sourceType === 'email_attachment',
						'bg-brand-subtle text-brand': sourceType === 'agent_generated',
					}"
				>
					<Icon
						:name="
							sourceType === 'upload'
								? 'lucide:upload'
								: sourceType === 'email_attachment'
									? 'lucide:mail'
									: 'lucide:sparkles'
						"
						class="w-3 h-3"
					/>
					{{ sourceLabel }}
				</span>
			</div>
		</div>
	</div>
</template>
