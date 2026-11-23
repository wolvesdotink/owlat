<script setup lang="ts">
/**
 * The report's line about sends that did not arrive: how many could not be
 * sent and how many bounced, each opening its reasons and its list of
 * recipients. Renders nothing when every send arrived, so a clean report
 * looks the same as one without this section.
 */
import type { FunctionReturnType } from 'convex/server';
// TYPE-ONLY: the section needs the query's return shape, never the client.
import type { api } from '@owlat/api';
import SendFailureReason from '~/components/dashboard/SendFailureReason.vue';
import { failureLabelKey, groupFailureReasons } from '~/lib/sendFailureReasons';
import { formatNumber } from '~/utils/formatters';
import { ChevronDownIcon, CircleCloseIcon, TriangleWarningIcon } from '@coolicons/vue';

type UndeliveredKind = 'failed' | 'bounced';

const props = defineProps<{
	summary: FunctionReturnType<typeof api.delivery.sendFailures.getFailureSummary> | undefined;
}>();

const emit = defineEmits<{ showList: [kind: UndeliveredKind] }>();

const { t } = useI18n();

const rows = computed(() => {
	const summary = props.summary;
	if (!summary) return [];
	const entries: {
		kind: UndeliveredKind;
		total: number;
		headline: string;
		reasons: ReturnType<typeof groupFailureReasons>;
	}[] = [
		{
			kind: 'failed',
			total: summary.failed.total,
			headline: t(
				'dashboard.campaigns.detail.report.failures.notSent',
				{ count: formatNumber(summary.failed.total) },
				summary.failed.total
			),
			reasons: groupFailureReasons(summary.failed.reasons),
		},
		{
			kind: 'bounced',
			total: summary.bounced.total,
			headline: t(
				'dashboard.campaigns.detail.report.failures.bounced',
				{ count: formatNumber(summary.bounced.total) },
				summary.bounced.total
			),
			reasons: groupFailureReasons(summary.bounced.reasons),
		},
	];
	return entries.filter((entry) => entry.total > 0);
});

const expanded = ref<Record<UndeliveredKind, boolean>>({ failed: false, bounced: false });
</script>

<template>
	<section
		v-if="rows.length > 0"
		class="space-y-3"
		:aria-label="t('dashboard.campaigns.detail.report.failures.ariaLabel')"
		data-testid="report-failures"
	>
		<div
			v-for="row in rows"
			:key="row.kind"
			class="rounded-lg border border-border-subtle"
			:data-kind="row.kind"
		>
			<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
				<button
					type="button"
					class="flex items-center gap-2 text-sm font-medium text-text-primary"
					:aria-expanded="expanded[row.kind]"
					:aria-controls="`report-failures-${row.kind}`"
					data-testid="report-failures-toggle"
					@click="expanded[row.kind] = !expanded[row.kind]"
				>
					<component
						:is="row.kind === 'failed' ? TriangleWarningIcon : CircleCloseIcon"
						class="h-4 w-4 text-error"
						aria-hidden="true"
					/>
					{{ row.headline }}
					<ChevronDownIcon
						class="h-4 w-4 text-text-tertiary transition-transform duration-(--motion-fast)"
						:class="expanded[row.kind] ? 'rotate-180' : ''"
						aria-hidden="true"
					/>
				</button>
				<UiButton variant="ghost" class="text-sm" @click="emit('showList', row.kind)">
					{{ t('dashboard.campaigns.detail.report.failures.showWho') }}
				</UiButton>
			</div>
			<ul
				v-if="expanded[row.kind]"
				:id="`report-failures-${row.kind}`"
				class="divide-y divide-border-subtle border-t border-border-subtle"
			>
				<li
					v-for="reason in row.reasons"
					:key="reason.failureClass"
					class="space-y-1 px-3 py-3"
					:data-class="reason.failureClass"
				>
					<div class="flex items-baseline justify-between gap-3 text-sm">
						<span class="font-medium text-text-primary">
							{{ t(failureLabelKey(reason.failureClass)) }}
						</span>
						<span class="tabular-nums text-text-tertiary">
							{{
								t(
									'dashboard.campaigns.detail.report.failures.sendCount',
									{ count: formatNumber(reason.count) },
									reason.count
								)
							}}
						</span>
					</div>
					<SendFailureReason
						:failure-class="reason.failureClass"
						:error-code="reason.errorCode"
						:provider-text="reason.exampleMessage"
					/>
				</li>
			</ul>
		</div>
	</section>
</template>
