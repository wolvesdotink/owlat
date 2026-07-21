<script setup lang="ts">
import { api } from '@owlat/api';
import { formatNumber, formatPercentage } from '~/utils/formatters';

const { data: telemetry, isLoading } = useOrganizationQuery(
	api.analytics.complianceTelemetry.getComplianceTelemetry
);

function formatDuration(milliseconds: number | null): string {
	if (milliseconds === null) return 'Collecting data';
	if (milliseconds < 1_000) return `≤ ${milliseconds} ms`;
	if (milliseconds < 60_000) return `≤ ${Math.round(milliseconds / 1_000)} s`;
	if (milliseconds < 3_600_000) return `≤ ${Math.round(milliseconds / 60_000)} min`;
	return `≤ ${Math.round(milliseconds / 3_600_000)} h`;
}

const SPAM_RATE_TONE = {
	no_data: 'border-border-subtle',
	on_target: 'border-success/40 bg-success/5',
	elevated: 'border-warning/40 bg-warning/5',
	hard_limit: 'border-error/40 bg-error/5',
} as const;

const SPAM_RATE_LABEL = {
	no_data: 'No data',
	on_target: 'On target',
	elevated: 'Above target',
	hard_limit: 'At hard line',
} as const;
</script>

<template>
	<UiCard>
		<div class="space-y-5">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:gauge" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Sender compliance</h2>
					<p class="text-sm text-text-secondary">
						The provider limits that can change inbox delivery
					</p>
				</div>
			</div>

			<div
				v-if="isLoading"
				data-testid="compliance-loading"
				class="h-24 animate-pulse rounded-lg bg-surface-subtle"
			/>
			<div v-else-if="telemetry" class="grid gap-4 lg:grid-cols-3">
				<section
					data-testid="spam-rate"
					class="rounded-lg border p-4"
					:class="SPAM_RATE_TONE[telemetry.spamRate.status]"
				>
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-text-primary">FBL spam rate · 30 days</p>
						<span class="text-xs font-medium text-text-secondary">
							{{ SPAM_RATE_LABEL[telemetry.spamRate.status] }}
						</span>
					</div>
					<p class="mt-2 text-2xl font-semibold tabular-nums text-text-primary">
						{{
							telemetry.spamRate.spamRate === null
								? 'No data'
								: formatPercentage(telemetry.spamRate.spamRate, 3)
						}}
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						Target &lt; {{ formatPercentage(telemetry.spamRate.target, 1) }} · hard line
						{{ formatPercentage(telemetry.spamRate.hardThreshold, 1) }}
					</p>
					<p class="mt-3 text-xs text-text-tertiary">
						Owlat clean-day evidence is an internal early signal, not Google mitigation eligibility.
						Verify Postmaster Tools and every sender requirement.
					</p>
					<p
						data-testid="spam-recovery-progress"
						class="mt-2 text-xs font-medium text-text-secondary"
					>
						<span>{{ telemetry.spamRate.cleanInternalDaysBelowHardThreshold }}</span>
						/
						<span>{{ telemetry.spamRate.internalCleanDaysRequired }}</span>
						clean active days in Owlat data
						<span v-if="telemetry.spamRate.hasRequiredInternalCleanDayEvidence">
							· evidence complete
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
					<p class="text-sm font-medium text-text-primary">Gmail-provider proximity · 24 h</p>
					<p class="mt-2 text-2xl font-semibold tabular-nums text-text-primary">
						{{ formatNumber(telemetry.gmail.highestVolumeDomain?.delivered24h ?? 0) }}
						<span class="text-sm font-normal text-text-secondary">/ ~5,000</span>
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						{{
							telemetry.gmail.highestVolumeDomain?.primaryDomain ?? 'No MTA-observed Gmail traffic'
						}}
					</p>
					<p
						v-if="telemetry.gmail.approachingBulkClassification"
						class="mt-3 text-xs font-medium text-warning"
					>
						You are approaching permanent Gmail bulk-sender classification. Verify SPF, DKIM, DMARC,
						TLS, one-click unsubscribe, and spam rate before crossing.
					</p>
					<p v-else class="mt-3 text-xs text-text-tertiary">
						MX-derived Gmail destinations; primary-domain totals use hourly buckets (up to 60 min
						overlap).
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
					<p class="text-sm font-medium text-text-primary">One-click processing p95</p>
					<p class="mt-2 text-2xl font-semibold tabular-nums text-text-primary">
						{{ formatDuration(telemetry.unsubscribe.p95Ms) }}
					</p>
					<p class="mt-1 text-xs text-text-secondary">
						{{ formatNumber(telemetry.unsubscribe.sampleCount) }} requests · 30 days
					</p>
					<p
						class="mt-3 text-xs"
						:class="
							telemetry.unsubscribe.exceedsHonorWindow
								? 'text-error font-medium'
								: 'text-text-tertiary'
						"
					>
						Yahoo and Google expect unsubscribe requests honored within 48 hours. Owlat applies the
						suppression synchronously before recording this sample.
					</p>
				</section>
			</div>
		</div>
	</UiCard>
</template>
