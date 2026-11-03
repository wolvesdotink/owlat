<script setup lang="ts">
import { entryTypeIcon } from '~/utils/knowledgeEntryTypes';
import { FileTextIcon } from '@coolicons/vue';

const props = defineProps<{
	kind: 'knowledge' | 'file';
	title: string;
	/** Present for knowledge sources — drives the entry-type icon. */
	entryType?: string;
	/** Present for file sources — shown in the hover tooltip. */
	filename?: string;
}>();

const { t } = useI18n();

const icon = computed(() =>
	props.kind === 'file' ? FileTextIcon : entryTypeIcon(props.entryType ?? '')
);

const tooltip = computed(() =>
	props.kind === 'file'
		? t('components.query.sourceCitation.fileTooltip', { name: props.filename ?? props.title })
		: t('components.query.sourceCitation.knowledgeTooltip', {
				entryType: props.entryType ?? t('components.query.sourceCitation.knowledgeFallback'),
				title: props.title,
			})
);
</script>

<template>
	<UiTooltip :text="tooltip">
		<button
			class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors"
		>
			<component :is="icon" class="w-3 h-3 text-text-tertiary" />
			<span class="truncate max-w-[200px]">{{ title }}</span>
		</button>
	</UiTooltip>
</template>
