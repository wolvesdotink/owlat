<script setup lang="ts">
/**
 * Team Inbox filters: the four status tabs (Open / Waiting / Snoozed /
 * Resolved), each with a live count, and — separately — the assignment filter
 * (Anyone / Me / Unassigned). They used to be one row of seven pills that mixed
 * the two ideas and had a tab that was a subset of another. The active tab
 * takes the terracotta brand-soft treatment (weight + accent, never a large
 * fill). Counts read at most `cap` rows server-side, so a slice at the ceiling
 * shows "99+".
 */
import {
	INBOX_ASSIGNEES,
	INBOX_ASSIGNEE_META,
	INBOX_FILTERS,
	INBOX_FILTER_META,
	type InboxAssignee,
	type InboxFilter,
	type InboxFilterCounts,
} from '~/utils/inboxFilters';

const props = defineProps<{
	modelValue: InboxFilter;
	assignee: InboxAssignee;
	counts: InboxFilterCounts | null | undefined;
}>();

const emit = defineEmits<{
	'update:modelValue': [InboxFilter];
	'update:assignee': [InboxAssignee];
}>();

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
	const value = counts[filter];
	if (typeof value !== 'number') return null;
	if (value >= counts.cap) return `${counts.cap - 1}+`;
	return String(value);
}
</script>

<template>
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
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
		<div
			role="group"
			:aria-label="t('components.inbox.inboxFilterPills.assigneeLabel')"
			class="inline-flex items-center rounded-full bg-bg-surface p-0.5"
			data-testid="inbox-assignee-filter"
		>
			<button
				v-for="a in INBOX_ASSIGNEES"
				:key="a"
				type="button"
				:aria-pressed="assignee === a"
				class="rounded-full px-3 py-1 text-xs font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
				:class="
					assignee === a
						? 'bg-bg-elevated text-text-primary shadow-(--shadow-1)'
						: 'text-text-secondary hover:text-text-primary'
				"
				@click="emit('update:assignee', a)"
			>
				{{ t(INBOX_ASSIGNEE_META[a].label) }}
			</button>
		</div>
	</div>
</template>
