<script setup lang="ts">
/**
 * Team Inbox filter pills — one focused row that replaces the old status
 * <select> + "Assigned to me" checkbox + 8-cell stats grid. Each pill is a
 * slice of the shared inbox carrying a live count; the active pill takes the
 * terracotta brand-soft treatment (weight + accent, never a large fill). Counts
 * read at most `cap` rows server-side, so a slice at the ceiling shows "99+".
 */
import {
	INBOX_FILTERS,
	INBOX_FILTER_COUNT_KEY,
	INBOX_FILTER_META,
	type InboxFilter,
	type InboxFilterCounts,
} from '~/utils/inboxFilters';

const props = defineProps<{
	modelValue: InboxFilter;
	counts: InboxFilterCounts | null | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [InboxFilter] }>();

const { t } = useI18n();

/**
 * Render a capped count: a slice at the ceiling reads "99+".
 *
 * A field the payload does not carry hides the badge rather than printing it:
 * an older/partial `getThreadFilterCounts` shape (a new pill shipped ahead of
 * the query, a cached response) would otherwise render the literal
 * "undefined" beside the pill's label.
 */
function displayCount(filter: InboxFilter): string | null {
	const counts = props.counts;
	if (!counts) return null;
	// The escalation pill's wire field is not its slug (see the registry).
	const value = counts[INBOX_FILTER_COUNT_KEY[filter]];
	if (typeof value !== 'number') return null;
	if (value >= counts.cap) return `${counts.cap - 1}+`;
	return String(value);
}
</script>

<template>
	<div
		role="group"
		:aria-label="t('components.inbox.inboxFilterPills.groupLabel')"
		class="flex flex-wrap items-center gap-2"
	>
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
			<!-- The filter registry holds i18n keys, not copy (see the localization guide). -->
			<span>{{ t(INBOX_FILTER_META[f].label) }}</span>
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
