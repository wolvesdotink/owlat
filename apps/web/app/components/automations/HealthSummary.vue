<script lang="ts">
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

/** One automation's last-7-days counts, as `automations.health.summaries` answers. */
export type AutomationHealth = FunctionReturnType<typeof api.automations.health.summaries>[number];
</script>

<script setup lang="ts">
/**
 * An automation's runs in one line: "230 entered · 40 waiting · 2 stalled · 1
 * failed". Entered, stalled and failed count the last 7 days; waiting counts
 * the runs whose email waits for the sending setup right now. The table's
 * column and the card list both render this, so the two layouts say the same
 * thing. Every count but entered links to the detail page's runs panel,
 * filtered to the runs it counts; a failure also carries a red dot. Under the counts, the
 * runs panel's sentences say what the runs wait for (every reason among them,
 * since each needs its own fix) and why the latest one failed. A draft has no detail page, so its counts stay plain text. While the
 * counts load (or for an automation past the first page) it shows a dash.
 */
import type { Id } from '@owlat/api/dataModel';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	automationId: Id<'automations'>;
	/** A draft's detail page is withheld, so its counts are not links. */
	linkable: boolean;
	health: AutomationHealth | undefined;
}>();

// Loaded with the first row that has something to explain.
const AutomationsHealthNote = defineAsyncComponent(
	() => import('~/components/automations/HealthNote.vue')
);

const { t } = useI18n();

type IssueKind = 'waiting' | 'stalled' | 'failed';

/** The counts that point at runs worth a look, in the order the line reads. */
const issues = computed(() => {
	const health = props.health;
	if (!health) return [];
	const waiting = health.waiting;
	return (
		(
			[
				{
					kind: 'waiting',
					count: waiting?.count ?? 0,
					label: waiting?.hasMore ? 'waitingMore' : 'waiting',
					tone: 'text-warning',
				},
				{ kind: 'stalled', count: health.stalled, label: 'stalled', tone: 'text-warning' },
				{ kind: 'failed', count: health.failed, label: 'failed', tone: 'text-error' },
			] as const
		)
			// A count cut short by the list page's read budget before it found a
			// waiting run says nothing here; the detail page reads every step.
			.filter((issue) => issue.count > 0)
	);
});

/** What the runs wait for (each reason, most runs first) and why the latest failed. */
const notes = computed(() => {
	const health = props.health;
	if (!health) return [];
	const notes = [];
	for (const waitingFor of health.waiting?.reasons ?? []) {
		notes.push({
			kind: `waiting-${waitingFor.reason}`,
			failure: { reason: waitingFor.reason, detail: null, until: waitingFor.until },
		});
	}
	if (health.failed > 0 && health.latestFailure) {
		notes.push({ kind: 'failed', failure: { reason: health.latestFailure, detail: null } });
	}
	return notes;
});

const runsLink = (filter: IssueKind) =>
	`/dashboard/automations/${props.automationId}?runs=${filter}#runs`;

const linkClass =
	'whitespace-nowrap rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
</script>

<template>
	<span v-if="!health" class="text-text-tertiary">—</span>
	<!-- Inline text: it wraps only between counts (a count never splits from its
	     dot), and the separators keep their spaces. -->
	<span v-else class="tabular-nums">
		<span class="whitespace-nowrap">
			{{ t('dashboard.automations.index.health.entered', { count: formatNumber(health.entered) }) }}
		</span>
		<template v-for="issue in issues" :key="issue.kind">
			<span aria-hidden="true"> · </span>
			<NuxtLink v-if="linkable" :to="runsLink(issue.kind)" :class="[linkClass, issue.tone]">
				<span
					v-if="issue.kind === 'failed'"
					class="inline-block size-2 mr-1 rounded-full bg-error align-middle"
					aria-hidden="true"
				/>
				{{
					t(`dashboard.automations.index.health.${issue.label}`, {
						count: formatNumber(issue.count),
					})
				}}
			</NuxtLink>
			<span v-else :class="['whitespace-nowrap', issue.tone]">
				<span
					v-if="issue.kind === 'failed'"
					class="inline-block size-2 mr-1 rounded-full bg-error align-middle"
					aria-hidden="true"
				/>
				{{
					t(`dashboard.automations.index.health.${issue.label}`, {
						count: formatNumber(issue.count),
					})
				}}
			</span>
		</template>
		<AutomationsHealthNote
			v-for="note in notes"
			:key="note.kind"
			:failure="note.failure"
			:automation-id="automationId"
			class="mt-1 max-w-72 line-clamp-2 text-xs text-text-tertiary"
			:data-testid="`health-note-${note.kind}`"
		/>
	</span>
</template>
