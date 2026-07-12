<script setup lang="ts">
/**
 * Delivery-page card for inbound SMTP TLS Reports (TLS-RPT, RFC 8460).
 *
 * We publish a `_smtp._tls` reporting address; other mail servers send us daily
 * aggregate reports about how TLS negotiation went when they delivered mail TO
 * us. This card is where an operator sees that loop close: an overall success
 * rate, per-partner rates, and a plain-language breakdown of any failures
 * ("STARTTLS stripped upstream", "certificate didn't match the server name").
 *
 * Prop-driven so the presentation is unit-tested directly; the Delivery page
 * owns the (member-safe) query and passes the result in. Every state — loading,
 * error, empty, populated — is rendered explicitly.
 */
import {
	formatSuccessRate,
	successRateTone,
	toFailureRows,
	type TlsReportSummary,
} from '~/utils/tlsReportView';
import { healthChipClass, healthDotClass, healthTextClass } from '~/utils/healthTone';

const props = defineProps<{
	summary: TlsReportSummary | null | undefined;
	isLoading: boolean;
	error?: unknown;
}>();

const hasData = computed(() => !!props.summary && props.summary.reportCount > 0);
const overallTone = computed(() => successRateTone(props.summary?.overallSuccessRate ?? null));
const failureRows = computed(() => toFailureRows(props.summary?.failureTypeCounts ?? []));
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-6">
			<!-- Headline -->
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:shield-check" size="md" variant="brand" rounded="lg" />
				<div class="min-w-0">
					<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
						Inbound TLS reports
					</p>
					<h2 class="text-lg font-semibold text-text-primary">How partners reach us over TLS</h2>
					<p class="text-sm text-text-secondary mt-0.5">
						Daily reports other mail servers send us about encrypting mail on the way in.
					</p>
				</div>
			</div>

			<!-- Loading -->
			<div
				v-if="isLoading"
				class="mt-5 flex items-center gap-3 text-text-tertiary"
				data-testid="tls-report-loading"
			>
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin" />
				<span class="text-sm">Loading TLS reports…</span>
			</div>

			<!-- Error -->
			<div
				v-else-if="error"
				class="mt-5 flex items-start gap-2 text-sm text-text-secondary"
				data-testid="tls-report-error"
			>
				<Icon name="lucide:alert-circle" class="w-4 h-4 text-warning mt-0.5 shrink-0" />
				<span>Couldn’t load TLS reports just now. Reload to try again.</span>
			</div>

			<!-- Empty -->
			<div
				v-else-if="!hasData"
				class="mt-5 flex items-start gap-2 text-sm text-text-secondary rounded-lg bg-bg-surface px-3 py-3"
				data-testid="tls-report-empty"
			>
				<Icon name="lucide:inbox" class="w-4 h-4 text-text-tertiary mt-0.5 shrink-0" />
				<span>
					No TLS reports yet. Once you publish a reporting address, partners send these daily —
					they’ll show up here.
				</span>
			</div>

			<!-- Populated -->
			<div v-else-if="summary" class="mt-5 space-y-5" data-testid="tls-report-body">
				<!-- Overall success rate -->
				<div class="flex items-center gap-3">
					<span
						class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-semibold"
						:class="healthChipClass[overallTone]"
						data-testid="tls-report-overall"
					>
						<span class="w-1.5 h-1.5 rounded-full" :class="healthDotClass[overallTone]" />
						{{ formatSuccessRate(summary.overallSuccessRate) }} encrypted
					</span>
					<span class="text-xs text-text-tertiary">
						{{ summary.totalSuccessCount + summary.totalFailureCount }} sessions ·
						{{ summary.reportCount }} reports · last {{ summary.windowDays }} days
					</span>
				</div>

				<!-- Per-partner table -->
				<div>
					<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary mb-2">
						By partner
					</p>
					<ul class="divide-y divide-border-subtle">
						<li
							v-for="partner in summary.partners"
							:key="partner.domain"
							class="flex items-center justify-between gap-3 py-2"
							data-testid="tls-report-partner"
						>
							<span class="text-sm text-text-primary truncate">{{ partner.domain }}</span>
							<span
								class="text-sm font-medium shrink-0"
								:class="healthTextClass[successRateTone(partner.successRate)]"
							>
								{{ formatSuccessRate(partner.successRate) }}
							</span>
						</li>
					</ul>
				</div>

				<!-- Failure-type breakdown (plain language) -->
				<div v-if="failureRows.length > 0">
					<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary mb-2">
						What went wrong
					</p>
					<ul class="space-y-1.5">
						<li
							v-for="row in failureRows"
							:key="row.type"
							class="flex items-center justify-between gap-3 text-sm"
							data-testid="tls-report-failure"
						>
							<span class="flex items-center gap-2 text-text-secondary">
								<Icon name="lucide:shield-off" class="w-4 h-4 text-warning shrink-0" />
								{{ row.label }}
							</span>
							<span class="text-text-tertiary shrink-0">{{ row.count }}</span>
						</li>
					</ul>
				</div>
			</div>
		</div>
	</UiCard>
</template>
