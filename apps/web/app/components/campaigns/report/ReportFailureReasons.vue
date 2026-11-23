<script setup lang="ts">
/**
 * The reasons under one expanded failure line of the report: one row per
 * failure class with its label, count and sentence. Loaded only when a line
 * is expanded, so the reason catalog stays off the report's first load.
 */
import SendFailureReason from '~/components/dashboard/SendFailureReason.vue';
import { failureLabelKey, groupFailureReasons } from '~/lib/sendFailureReasons';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	reasons: Parameters<typeof groupFailureReasons>[0];
}>();

const { t } = useI18n();

const groups = computed(() => groupFailureReasons(props.reasons));
</script>

<template>
	<ul class="divide-y divide-border-subtle border-t border-border-subtle">
		<li
			v-for="reason in groups"
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
</template>
