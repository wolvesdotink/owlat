<script setup lang="ts">
/**
 * Response analytics per assignee: conversations, median and 90th-percentile
 * first response, and the response-target hit rate. A table rather than a
 * chart: the reader compares a handful of people across four numbers, and a
 * table keeps every value readable without colour.
 */
import { formatNumber, formatPercentage } from '~/utils/formatters';
import { inboxSlaDurationLabel } from '~/utils/inboxSla';

export interface InboxSlaAssigneeRow {
	userId: string | null;
	conversations: number;
	firstResponse: { median: number; p90: number; count: number } | null;
	met: number;
	missed: number;
	overdueNow: number;
	hitRate: number | null;
}

const props = defineProps<{
	rows: InboxSlaAssigneeRow[];
	names: Record<string, string>;
}>();

const { t } = useI18n();

function duration(ms: number | undefined): string {
	if (ms === undefined) return '—';
	const label = inboxSlaDurationLabel(ms);
	return t(label.key, label.params);
}

const rendered = computed(() =>
	props.rows.map((row) => ({
		key: row.userId ?? 'unassigned',
		name: row.userId
			? (props.names[row.userId] ?? t('components.inbox.inboxSlaAssigneeTable.formerMember'))
			: t('components.inbox.inboxSlaAssigneeTable.unassigned'),
		conversations: formatNumber(row.conversations),
		median: duration(row.firstResponse?.median),
		p90: duration(row.firstResponse?.p90),
		hitRate: row.hitRate === null ? '—' : formatPercentage(row.hitRate, 0),
		overdueNow: row.overdueNow,
	}))
);
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full text-sm">
			<thead>
				<tr class="text-left text-xs text-text-tertiary border-b border-border-subtle">
					<th scope="col" class="py-2 pr-4 font-medium">
						{{ t('components.inbox.inboxSlaAssigneeTable.assignee') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium text-right">
						{{ t('components.inbox.inboxSlaAssigneeTable.conversations') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium text-right">
						{{ t('components.inbox.inboxSlaAssigneeTable.medianFirstResponse') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium text-right">
						{{ t('components.inbox.inboxSlaAssigneeTable.p90FirstResponse') }}
					</th>
					<th scope="col" class="py-2 font-medium text-right">
						{{ t('components.inbox.inboxSlaAssigneeTable.hitRate') }}
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border-subtle">
				<tr v-for="row in rendered" :key="row.key" data-testid="inbox-sla-assignee-row">
					<th scope="row" class="py-2 pr-4 font-normal text-text-primary text-left">
						{{ row.name }}
						<span v-if="row.overdueNow > 0" class="ml-2 text-xs text-error">
							{{
								t(
									'components.inbox.inboxSlaAssigneeTable.overdueNow',
									{ count: row.overdueNow },
									row.overdueNow
								)
							}}
						</span>
					</th>
					<td class="py-2 pr-4 text-right tabular-nums text-text-secondary">
						{{ row.conversations }}
					</td>
					<td class="py-2 pr-4 text-right tabular-nums text-text-secondary">{{ row.median }}</td>
					<td class="py-2 pr-4 text-right tabular-nums text-text-secondary">{{ row.p90 }}</td>
					<td class="py-2 text-right tabular-nums text-text-secondary">{{ row.hitRate }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
