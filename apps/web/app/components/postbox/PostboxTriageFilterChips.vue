<script setup lang="ts">
/**
 * Triage filter chips for the Postbox list — All / Unread / Starred /
 * Attachments, with live counts. One tap from "everything" to "what needs
 * me": before this the only route to "show me unread" was typing `is:unread`
 * into search. The flags are already projected on every row, so filtering is
 * client-side over the fetched window (instant, offline-safe, no queries).
 *
 * Counts always reflect the UNFILTERED rows, so a chip never hides its own
 * badge. Rendered under the list header on flat-list folders only — the
 * grouped renderers own their sections.
 */
import type { PostboxTriageFilter } from '~/composables/postbox/usePostboxTriageFilters';

defineProps<{
	filter: PostboxTriageFilter;
	counts: { all: number; unread: number; starred: number; attachments: number };
}>();

const emit = defineEmits<{
	'select-filter': [value: PostboxTriageFilter];
}>();

const { t } = useI18n();

const CHIPS: Array<{ value: PostboxTriageFilter; labelKey: string }> = [
	{ value: 'all', labelKey: 'components.postbox.postboxTriageFilterChips.all' },
	{ value: 'unread', labelKey: 'components.postbox.postboxTriageFilterChips.unread' },
	{ value: 'starred', labelKey: 'components.postbox.postboxTriageFilterChips.starred' },
	{ value: 'attachments', labelKey: 'components.postbox.postboxTriageFilterChips.attachments' },
];
</script>

<template>
	<div
		class="px-4 pb-2.5 -mt-1 flex items-center gap-1.5 overflow-x-auto"
		role="group"
		:aria-label="t('components.postbox.postboxTriageFilterChips.groupLabel')"
	>
		<button
			v-for="chip in CHIPS"
			:key="chip.value"
			type="button"
			class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
			:class="
				filter === chip.value
					? 'bg-brand-subtle border-brand/25 text-brand font-medium'
					: 'border-border-default bg-bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong'
			"
			:aria-pressed="filter === chip.value"
			@click="emit('select-filter', chip.value)"
		>
			{{ t(chip.labelKey) }}
			<span
				class="text-2xs tabular-nums"
				:class="filter === chip.value ? 'text-brand' : 'text-text-tertiary'"
				>{{ counts[chip.value] }}</span
			>
		</button>
	</div>
</template>
