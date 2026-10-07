<script setup lang="ts">
/**
 * `Overview | Conversation (N)` (SPEC §7): which view of a personal thread the
 * reader shows. Lives in the thread header; on a phone it spans the full width
 * under the subject (plan §7). The reader owns what a switch means (it saves
 * the choice for this thread); this only reports it.
 */
import type { ThreadView } from '@owlat/shared/threadBrief';

const props = defineProps<{
	view: ThreadView;
	messageCount: number;
	/** Full width (the phone row under the subject). */
	full?: boolean;
}>();

const emit = defineEmits<{ 'update:view': [view: ThreadView] }>();

const { t } = useI18n();

const options = computed(() => [
	{ value: 'overview', label: t('components.brief.view.overview') },
	{
		value: 'conversation',
		label: t('components.brief.view.conversation', { count: props.messageCount }),
	},
]);

function onUpdate(value: string) {
	if (value === 'overview' || value === 'conversation') emit('update:view', value);
}
</script>

<template>
	<div
		role="group"
		:aria-label="t('components.brief.view.label')"
		:class="full ? 'w-full' : 'flex-shrink-0'"
		data-testid="thread-view-switch"
	>
		<UiSegmentedControl
			:options="options"
			:model-value="view"
			size="sm"
			:fit="full ? 'equal' : 'content'"
			:class="full ? 'w-full' : ''"
			@update:model-value="onUpdate"
		/>
	</div>
</template>
