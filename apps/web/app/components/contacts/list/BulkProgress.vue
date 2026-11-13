<script setup lang="ts">
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

// The contacts list's progress strip while a bulk operation runs.
const props = defineProps<{
	active: boolean;
	type: string | null;
	/** Percent done, 0-100. */
	progress: number;
}>();

const { t } = useI18n();

const label = computed(() => {
	if (props.type === 'add') return t('dashboard.audience.contacts.index.bulk.progress.add');
	if (props.type === 'remove') return t('dashboard.audience.contacts.index.bulk.progress.remove');
	if (props.type === 'delete') return t('dashboard.audience.contacts.index.bulk.progress.delete');
	if (props.type === 'export') return t('dashboard.audience.contacts.index.bulk.progress.export');
	return '';
});
</script>

<template>
	<Transition
		enter-active-class="duration-(--motion-moderate) ease-spring"
		enter-from-class="opacity-0 scale-95"
		enter-to-class="opacity-100 scale-100"
		leave-active-class="duration-(--motion-moderate-exit) ease-exit"
		leave-from-class="opacity-100 scale-100"
		leave-to-class="opacity-0 scale-95"
	>
		<div v-if="active" class="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-surface">
			<SpinnerIcon class="w-4 h-4 text-brand" aria-hidden="true" />
			<!-- The label is a live region, so starting a bulk action is announced. -->
			<span class="text-sm text-text-secondary" role="status">{{ label }}</span>
			<UiProgressBar class="w-20" size="sm" :value="progress" :aria-label="label" />
			<span class="text-xs text-text-tertiary" aria-hidden="true">{{ progress }}%</span>
		</div>
	</Transition>
</template>
