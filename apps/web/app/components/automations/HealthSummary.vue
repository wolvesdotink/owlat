<script lang="ts">
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

/** One automation's last-7-days counts, as `automations.health.summaries` answers. */
export type AutomationHealth = FunctionReturnType<typeof api.automations.health.summaries>[number];
</script>

<script setup lang="ts">
/**
 * An automation's last 7 days in one line: "230 entered · 2 stalled · 1
 * failed". The table's column and the card list both render this, so the two
 * layouts say the same thing. A stall or failure count links to the detail
 * page's runs, filtered to the runs it counts; a failure also carries a red
 * dot. A draft has no detail page, so its counts stay plain text. While the
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

const { t } = useI18n();

/** The counts that point at runs worth a look, in the order the line reads. */
const issues = computed(() => {
	const health = props.health;
	if (!health) return [];
	return (
		[
			{ kind: 'stalled', count: health.stalled, tone: 'text-warning' },
			{ kind: 'failed', count: health.failed, tone: 'text-error' },
		] as const
	).filter((issue) => issue.count > 0);
});

const runsLink = (filter: 'failed' | 'stalled') =>
	`/dashboard/automations/${props.automationId}?runs=${filter}`;

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
					t(`dashboard.automations.index.health.${issue.kind}`, {
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
					t(`dashboard.automations.index.health.${issue.kind}`, {
						count: formatNumber(issue.count),
					})
				}}
			</span>
		</template>
	</span>
</template>
