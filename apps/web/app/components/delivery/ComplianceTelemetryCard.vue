<script setup lang="ts">
import { api } from '@owlat/api';
import { formatNumber, formatPercentage } from '~/utils/formatters';

const { t } = useI18n();

const { data: telemetry, isLoading } = useOrganizationQuery(
	api.analytics.complianceTelemetry.getComplianceTelemetry
);

/** The catalog rejects `<` inside a message, so the comparison sign is a value. */
const LESS_THAN = '<';

const DURATION = 'components.delivery.complianceTelemetryCard.unsubscribe';

function formatDuration(milliseconds: number | null): string {
	if (milliseconds === null) return t(`${DURATION}.collecting`);
	if (milliseconds < 1_000) {
		return t(`${DURATION}.milliseconds`, { milliseconds });
	}
	if (milliseconds < 60_000) {
		return t(`${DURATION}.seconds`, { seconds: Math.round(milliseconds / 1_000) });
	}
	if (milliseconds < 3_600_000) {
		return t(`${DURATION}.minutes`, { minutes: Math.round(milliseconds / 60_000) });
	}
	return t(`${DURATION}.hours`, { hours: Math.round(milliseconds / 3_600_000) });
}

const SPAM_RATE_TONE = {
	no_data: 'border-border-subtle',
	on_target: 'border-success/40 bg-success/5',
	elevated: 'border-warning/40 bg-warning/5',
	hard_limit: 'border-error/40 bg-error/5',
} as const;

/** Message keys, resolved in the template so a locale switch repaints them. */
const SPAM_RATE_LABEL = {
	no_data: 'components.delivery.complianceTelemetryCard.spamRateStatus.noData',
	on_target: 'components.delivery.complianceTelemetryCard.spamRateStatus.onTarget',
	elevated: 'components.delivery.complianceTelemetryCard.spamRateStatus.elevated',
	hard_limit: 'components.delivery.complianceTelemetryCard.spamRateStatus.hardLimit',
} as const;
</script>

<template>
	<UiCard>
		<div class="space-y-5">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:gauge" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('components.delivery.complianceTelemetryCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.delivery.complianceTelemetryCard.subtitle') }}
					</p>
				</div>
			</div>

			<div
				v-if="isLoading"
				data-testid="compliance-loading"
				class="h-24 animate-pulse rounded-lg bg-bg-surface"
			/>
			<div v-else-if="telemetry" class="grid gap-4 lg:grid-cols-3">
				<section
					data-testid="spam-rate"
					class="rounded-lg border p-4"
					:class="SPAM_RATE_TONE[telemetry.spamRate.status]"
				>
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-text-primary">
							{{ t('components.delivery.complianceTelemetryCard.spamRate.title') }}
						</p>
						<span class="text-xs font-medium text-text-secondary">
							{{ t(SPAM_RATE_LABEL[telemetry.spamRate.status]) }}
						</span>
					</div>
					<p class="mt-2 text-2xl font-medium tracking-[-0.02em] tabular-nums text-text-primary">
						{{
							telemetry.spamRate.spamRate === null
								? t('components.delivery.complianceTelemetryCard.spamRate.noValue')
								: formatPercentage(telemetry.spamRate.spamRate, 3)
						}}
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						{{
							t('components.delivery.complianceTelemetryCard.spamRate.thresholds', {
								lessThan: LESS_THAN,
								target: formatPercentage(telemetry.spamRate.target, 1),
								hardLine: formatPercentage(telemetry.spamRate.hardThreshold, 1),
							})
						}}
					</p>
					<p class="mt-3 text-xs text-text-tertiary">
						{{ t('components.delivery.complianceTelemetryCard.spamRate.evidenceNote') }}
					</p>
					<p
						data-testid="spam-recovery-progress"
						class="mt-2 text-xs font-medium text-text-secondary"
					>
						{{
							t('components.delivery.complianceTelemetryCard.spamRate.cleanDays', {
								clean: telemetry.spamRate.cleanInternalDaysBelowHardThreshold,
								required: telemetry.spamRate.internalCleanDaysRequired,
							})
						}}
						<span v-if="telemetry.spamRate.hasRequiredInternalCleanDayEvidence">
							{{ t('components.delivery.complianceTelemetryCard.spamRate.evidenceComplete') }}
						</span>
					</p>
				</section>

				<section
					data-testid="gmail-proximity"
					class="rounded-lg border p-4"
					:class="
						telemetry.gmail.approachingBulkClassification
							? 'border-warning/40 bg-warning/5'
							: 'border-border-subtle'
					"
				>
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.delivery.complianceTelemetryCard.gmail.title') }}
					</p>
					<p class="mt-2 text-2xl font-medium tracking-[-0.02em] tabular-nums text-text-primary">
						{{ formatNumber(telemetry.gmail.highestVolumeDomain?.delivered24h ?? 0) }}
						<span class="text-sm font-normal text-text-secondary">
							{{ t('components.delivery.complianceTelemetryCard.gmail.bulkThreshold') }}
						</span>
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						{{
							telemetry.gmail.highestVolumeDomain?.primaryDomain ??
							t('components.delivery.complianceTelemetryCard.gmail.noTraffic')
						}}
					</p>
					<p
						v-if="telemetry.gmail.approachingBulkClassification"
						class="mt-3 text-xs font-medium text-warning"
					>
						{{ t('components.delivery.complianceTelemetryCard.gmail.approachingWarning') }}
					</p>
					<p v-else class="mt-3 text-xs text-text-tertiary">
						{{ t('components.delivery.complianceTelemetryCard.gmail.sourceNote') }}
					</p>
					<p v-if="telemetry.gmail.isDomainListTruncated" class="mt-1 text-xs text-text-tertiary">
						{{
							t('components.delivery.complianceTelemetryCard.gmail.truncated', {
								limit: telemetry.gmail.domainLimit,
							})
						}}
					</p>
				</section>

				<section
					data-testid="unsubscribe-latency"
					class="rounded-lg border p-4"
					:class="
						telemetry.unsubscribe.exceedsHonorWindow
							? 'border-error/40 bg-error/5'
							: 'border-border-subtle'
					"
				>
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.delivery.complianceTelemetryCard.unsubscribe.title') }}
					</p>
					<p class="mt-2 text-2xl font-medium tracking-[-0.02em] tabular-nums text-text-primary">
						{{ formatDuration(telemetry.unsubscribe.p95Ms) }}
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						{{
							t('components.delivery.complianceTelemetryCard.unsubscribe.samples', {
								count: formatNumber(telemetry.unsubscribe.sampleCount),
							})
						}}
					</p>
					<p
						class="mt-3 text-xs"
						:class="
							telemetry.unsubscribe.exceedsHonorWindow
								? 'text-error font-medium'
								: 'text-text-tertiary'
						"
					>
						{{ t('components.delivery.complianceTelemetryCard.unsubscribe.honorWindow') }}
					</p>
				</section>
			</div>
		</div>
	</UiCard>
</template>
