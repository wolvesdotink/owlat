<script setup lang="ts">
/**
 * Team Inbox filters: the four status tabs (Open / Waiting / Snoozed /
 * Resolved), each with a live count, and — separately — the assignment filter
 * (Anyone / Me / Unassigned). They used to be one row of seven pills that mixed
 * the two ideas and had a tab that was a subset of another. The active tab
 * takes the terracotta brand-soft treatment (weight + accent, never a large
 * fill). Counts read at most `cap` rows server-side, so a slice at the ceiling
 * shows "99+". While response targets are on, two more pills follow the tabs:
 * Overdue and Due soon (a reply deadline passed / passes within the hour).
 *
 * Last, Mentions: the threads a teammate @-mentioned you on in an internal
 * note, with how many you have not opened since. It is a view of its own, so
 * while it is on no status tab is pressed and the assignment filter steps
 * aside; picking a tab leaves it.
 */
import {
	INBOX_ASSIGNEES,
	INBOX_ASSIGNEE_META,
	INBOX_FILTERS,
	INBOX_FILTER_META,
	INBOX_SLA_FILTERS,
	type InboxAssignee,
	type InboxFilter,
	type InboxFilterCounts,
} from '~/utils/inboxFilters';

const props = withDefaults(
	defineProps<{
		modelValue: InboxFilter;
		assignee: InboxAssignee;
		counts: InboxFilterCounts | null | undefined;
		/** The Mentions view is on. */
		mentions?: boolean;
		/** Threads mentioning you that you have not opened since. */
		unreadMentions?: number;
		/** Response-target counts; absent or off hides the two highlight pills. */
		sla?: { isEnabled: boolean; overdue: number; dueSoon: number; cap: number } | null;
	}>(),
	{ mentions: false, unreadMentions: 0 }
);

const emit = defineEmits<{
	'update:modelValue': [InboxFilter];
	'update:assignee': [InboxAssignee];
	'update:mentions': [boolean];
}>();

function pickFilter(filter: InboxFilter) {
	emit('update:mentions', false);
	emit('update:modelValue', filter);
}

const { t } = useI18n();

/**
 * Render a capped count: a slice at the ceiling reads "99+".
 *
 * A field the payload does not carry hides the badge rather than printing it:
 * an older/partial `getThreadFilterCounts` shape (a new pill shipped ahead of
 * the query, a cached response) would otherwise render the literal
 * "undefined" beside the pill's label.
 */
function displayCount(filter: (typeof INBOX_FILTERS)[number]): string | null {
	const counts = props.counts;
	if (!counts) return null;
	const value = counts[filter];
	if (typeof value !== 'number') return null;
	if (value >= counts.cap) return `${counts.cap - 1}+`;
	return String(value);
}

const slaPills = computed(() => {
	const sla = props.sla;
	if (!sla?.isEnabled) return [];
	const capped = (value: number) => (value >= sla.cap ? `${sla.cap - 1}+` : String(value));
	return INBOX_SLA_FILTERS.map((f) => {
		const value = f === 'sla-overdue' ? sla.overdue : sla.dueSoon;
		return {
			filter: f,
			count: capped(value),
			// The tone marks a slice that has something in it; the label carries the meaning.
			dotClass: value === 0 ? 'bg-border-strong' : f === 'sla-overdue' ? 'bg-error' : 'bg-warning',
		};
	});
});
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
				:aria-pressed="!mentions && modelValue === f"
				class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
				:class="
					!mentions && modelValue === f
						? 'border-brand/30 bg-brand-soft text-brand'
						: 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface'
				"
				@click="pickFilter(f)"
			>
				<!-- The filter registry holds i18n keys, not copy (see the localization guide). -->
				<span>{{ t(INBOX_FILTER_META[f].label) }}</span>
				<span
					v-if="displayCount(f) !== null"
					class="tabular-nums text-xs"
					:class="!mentions && modelValue === f ? 'text-brand' : 'text-text-tertiary'"
				>
					{{ displayCount(f) }}
				</span>
			</button>
		</div>
		<div
			v-if="slaPills.length > 0"
			role="group"
			:aria-label="t('components.inbox.inboxFilterPills.slaLabel')"
			class="flex flex-wrap items-center gap-2"
			data-testid="inbox-sla-filters"
		>
			<button
				v-for="pill in slaPills"
				:key="pill.filter"
				type="button"
				:aria-pressed="!mentions && modelValue === pill.filter"
				class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
				:class="
					!mentions && modelValue === pill.filter
						? 'border-brand/30 bg-brand-soft text-brand'
						: 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface'
				"
				@click="pickFilter(pill.filter)"
			>
				<span class="w-1.5 h-1.5 rounded-full" :class="pill.dotClass" aria-hidden="true" />
				<span>{{ t(INBOX_FILTER_META[pill.filter].label) }}</span>
				<span
					class="tabular-nums text-xs"
					:class="!mentions && modelValue === pill.filter ? 'text-brand' : 'text-text-tertiary'"
				>
					{{ pill.count }}
				</span>
			</button>
		</div>
		<div
			v-if="!mentions"
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
		<button
			type="button"
			:aria-pressed="mentions"
			class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
			:class="
				mentions
					? 'border-brand/30 bg-brand-soft text-brand'
					: 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface'
			"
			data-testid="inbox-mentions-filter"
			@click="emit('update:mentions', !mentions)"
		>
			<Icon name="lucide:at-sign" class="size-3.5" aria-hidden="true" />
			<span>{{ t('components.inbox.inboxFilterPills.mentions') }}</span>
			<!-- aria-label on a plain span is not announced; spell it out instead. -->
			<span
				v-if="unreadMentions > 0"
				class="rounded-full bg-brand px-1.5 text-xs tabular-nums text-text-inverse"
				data-testid="inbox-mentions-unread"
			>
				<span aria-hidden="true">{{ unreadMentions }}</span>
				<span class="sr-only">{{
					t('components.inbox.inboxFilterPills.unreadMentions', { count: unreadMentions })
				}}</span>
			</span>
		</button>
	</div>
</template>
