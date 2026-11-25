<script setup lang="ts">
/**
 * The automation detail page's notice under the header: how many runs wait for
 * the sending setup and for what (each reason among them), and how many failed
 * in the last 7 days and why the latest one did. Each part says it in the runs
 * panel's sentence, with the same fix link, and links to the runs it counts.
 * The page mounts it only when there is something to say, so it loads only
 * then.
 */
import { CirclePauseIcon, CircleWarningIcon } from '@coolicons/vue';
import type { Id } from '@owlat/api/dataModel';
import type { AutomationHealth } from '~/components/automations/HealthSummary.vue';
import AutomationsRunFailureNote from '~/components/automations/RunFailureNote.vue';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{ automationId: Id<'automations'>; health: AutomationHealth }>();

const { t } = useI18n();
const route = useRoute();

// Every reason the counted runs wait for gets its sentence: fixing one of
// them releases only the runs waiting on it.
const waiting = computed(() => {
	const summary = props.health.waiting;
	if (!summary || summary.reasons.length === 0) return null;
	return {
		count: summary.count,
		label: summary.hasMore ? 'waitingTitleMore' : 'waitingTitle',
		failures: summary.reasons.map((entry) => ({
			reason: entry.reason,
			detail: null,
			until: entry.until,
		})),
	};
});

const failed = computed(() =>
	props.health.failed > 0
		? {
				count: props.health.failed,
				failure: props.health.latestFailure
					? { reason: props.health.latestFailure, detail: null }
					: null,
			}
		: null
);

const runsLink = (runs: 'waiting' | 'failed') => ({
	query: { ...route.query, runs },
	hash: '#runs',
});
</script>

<template>
	<div class="card p-4 mb-8 space-y-4" data-testid="automation-health-notice">
		<div v-if="waiting" class="flex gap-3" data-testid="automation-health-waiting">
			<CirclePauseIcon class="w-5 h-5 shrink-0 text-warning" aria-hidden="true" />
			<div class="min-w-0 space-y-1">
				<p class="text-sm font-medium text-text-primary">
					{{
						t(`dashboard.automations.detail.index.health.${waiting.label}`, waiting.count, {
							named: { count: formatNumber(waiting.count) },
						})
					}}
				</p>
				<AutomationsRunFailureNote
					v-for="failure in waiting.failures"
					:key="failure.reason"
					:failure="failure"
					:automation-id="automationId"
				/>
				<NuxtLink :to="runsLink('waiting')" class="link text-sm font-medium">
					{{ t('dashboard.automations.detail.index.health.showWaiting') }}
				</NuxtLink>
			</div>
		</div>
		<div v-if="failed" class="flex gap-3" data-testid="automation-health-failed">
			<CircleWarningIcon class="w-5 h-5 shrink-0 text-error" aria-hidden="true" />
			<div class="min-w-0 space-y-1">
				<p class="text-sm font-medium text-text-primary">
					{{
						t('dashboard.automations.detail.index.health.failedTitle', failed.count, {
							named: { count: formatNumber(failed.count) },
						})
					}}
				</p>
				<template v-if="failed.failure">
					<p class="text-xs text-text-tertiary">
						{{ t('dashboard.automations.detail.index.health.latestFailure') }}
					</p>
					<AutomationsRunFailureNote :failure="failed.failure" :automation-id="automationId" />
				</template>
				<NuxtLink :to="runsLink('failed')" class="link text-sm font-medium">
					{{ t('dashboard.automations.detail.index.health.showFailed') }}
				</NuxtLink>
			</div>
		</div>
	</div>
</template>
