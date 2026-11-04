<script setup lang="ts">
/**
 * The People view's one status mark, the same on every surface that lists
 * people or conversations (the column, a company's people, the topics column,
 * the sidebar, the Workbench): brand for what waits on you (a dot for one, the
 * count, also for one, so it never differs from unread by colour alone), a
 * hollow brand ring for a reply that only may be due, a grey dot for unread:
 * one scale from sure to merely new. The
 * first that applies wins; a row's unread state also shows in its weight.
 */
const props = withDefaults(
	defineProps<{
		owed?: number;
		mayOwe?: number;
		unread?: number;
		size?: 'sm' | 'md';
	}>(),
	{ owed: 0, mayOwe: 0, unread: 0, size: 'md' }
);

const { t } = useI18n();
const dot = computed(() => (props.size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'));
// The ring a size up from the dot, so the two differ by size as well as fill.
const ring = computed(() => (props.size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'));
const label = computed(() =>
	props.owed > 0
		? t('components.postbox.people.row.owed', { count: props.owed }, props.owed)
		: props.mayOwe > 0
			? t('components.postbox.people.row.mayOwe', { count: props.mayOwe }, props.mayOwe)
			: props.unread > 0
				? t('components.postbox.people.row.unread', { count: props.unread }, props.unread)
				: ''
);
</script>

<template>
	<span
		v-if="owed > 0"
		role="img"
		:aria-label="label"
		:title="label"
		class="min-w-[1.125rem] flex-shrink-0 rounded-full bg-brand px-1.5 text-center text-2xs font-semibold leading-4 tabular-nums text-text-inverse"
		>{{ owed > 99 ? '99+' : owed }}</span
	>
	<span
		v-else-if="label"
		role="img"
		:aria-label="label"
		:title="label"
		class="flex-shrink-0 rounded-full"
		:class="[
			mayOwe > 0 ? ring : dot,
			mayOwe > 0 ? 'ring-2 ring-inset ring-brand' : 'bg-text-tertiary dark:bg-text-tertiary/60',
		]"
	/>
</template>
