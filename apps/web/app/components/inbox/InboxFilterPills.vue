<script setup lang="ts">
/**
 * Team Inbox filter pills — one focused row that replaces the old status
 * <select> + "Assigned to me" checkbox + 8-cell stats grid. Each pill is a
 * slice of the shared inbox carrying a live count; the active pill takes the
 * terracotta brand-soft treatment (weight + accent, never a large fill). Counts
 * read at most `cap` rows server-side, so a slice at the ceiling shows "99+".
 */
import { INBOX_FILTERS, INBOX_FILTER_META, type InboxFilter } from '~/utils/inboxFilters';

type FilterCounts = {
	open: number;
	mine: number;
	unassigned: number;
	waiting: number;
	snoozed: number;
	resolved: number;
	cap: number;
};

const props = defineProps<{
	modelValue: InboxFilter;
	counts: FilterCounts | null | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [InboxFilter] }>();

/** Render a capped count: a slice at the ceiling reads "99+". */
function displayCount(filter: InboxFilter): string | null {
	const counts = props.counts;
	if (!counts) return null;
	const value = counts[filter];
	if (value >= counts.cap) return `${counts.cap - 1}+`;
	return String(value);
}
</script>

<template>
	<div role="group" aria-label="Filter threads" class="flex flex-wrap items-center gap-2">
		<button
			v-for="f in INBOX_FILTERS"
			:key="f"
			type="button"
			:aria-pressed="modelValue === f"
			class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
			:class="
				modelValue === f
					? 'border-brand/30 bg-brand-soft text-brand'
					: 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface'
			"
			@click="emit('update:modelValue', f)"
		>
			<span>{{ INBOX_FILTER_META[f].label }}</span>
			<span
				v-if="displayCount(f) !== null"
				class="tabular-nums text-xs"
				:class="modelValue === f ? 'text-brand' : 'text-text-tertiary'"
			>
				{{ displayCount(f) }}
			</span>
		</button>
	</div>
</template>
