<script setup lang="ts">
/**
 * The Workbench in Zen mode keeps only what needs an answer. This one line
 * says what it left out (what changed, updates, what was filed away) and
 * brings it back by leaving Zen. Nothing is marked as seen while it is hidden:
 * the Workbench's dwell rule only counts time the bands were on screen.
 */
defineProps<{
	/** The inbox this tab summarises. */
	inboxName: string;
	/** Lines left out: what changed, worth knowing, also arrived. */
	count: number;
}>();
const emit = defineEmits<{ show: [] }>();
const { t } = useI18n();
</script>

<template>
	<p
		v-if="count > 0"
		class="mt-8 flex flex-wrap items-center gap-x-2 text-sm text-text-secondary"
		data-testid="workbench-zen-more"
	>
		{{ t('components.today.zenMore.hidden', { count, inbox: inboxName }, count) }}
		<button
			type="button"
			class="text-text-primary underline decoration-border-default underline-offset-2 hover:decoration-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			@click="emit('show')"
		>
			{{ t('components.today.zenMore.show') }}
		</button>
	</p>
</template>
