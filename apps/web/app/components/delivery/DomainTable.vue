<script setup lang="ts">
/**
 * The Delivery health page's domain table — one browsing table that folds
 * per-domain health, email-auth verification, and 30-day volume together. One
 * status chip per row; auth is a single roll-up line ("SPF · DKIM · DMARC ✓")
 * or the specific missing records with an inline "Fix →" link straight to the
 * domain setup panel. A browsing surface, not a doing-surface: no second focal
 * point, weight-based emphasis, terracotta reserved for the fix link.
 */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { PROVIDER_SPAM_RATE_POLICY } from '@owlat/shared/reputation';
import { formatNumber, formatPercentage } from '~/utils/formatters';
import { healthChipClass, healthDotClass, type HealthTone } from '~/utils/healthTone';

// Derive the row type straight from the query's return so the two shapes can't
// drift — this is exactly what `getDeliveryDomainTable` yields per domain.
type DomainRow = FunctionReturnType<
	typeof api.analytics.reputationQueries.getDeliveryDomainTable
>[number];
type DomainStatus = DomainRow['status'];

defineProps<{ rows: DomainRow[] }>();

const DOMAIN_SETUP_ROUTE = '/dashboard/delivery/domains';

/** One lookup keyed off status: the chip's human label + its verification tone. */
const STATUS_META: Record<DomainStatus, { label: string; tone: HealthTone }> = {
	registering: { label: 'Registering', tone: 'warning' },
	pending: { label: 'Not verified', tone: 'warning' },
	verified: { label: 'Verified', tone: 'success' },
	failed: { label: 'Failed', tone: 'error' },
};

// The health DOT reflects reputation risk (a distinct signal from verification);
// no in-window activity → neutral, not a misleading green. The CHIP keeps
// encoding verification. Both use the shared tone→class maps.
const RISK_TONE: Record<NonNullable<DomainRow['riskLevel']>, HealthTone> = {
	low: 'success',
	medium: 'warning',
	high: 'error',
	critical: 'error',
};
function riskTone(riskLevel: DomainRow['riskLevel']): HealthTone {
	return riskLevel ? RISK_TONE[riskLevel] : 'neutral';
}
</script>

<template>
	<UiCard>
		<div class="space-y-4">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:globe" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Sending domains</h2>
					<p class="text-sm text-text-secondary">Verification and 30-day volume per domain</p>
				</div>
			</div>

			<UiEmptyState
				v-if="rows.length === 0"
				icon="lucide:globe"
				title="No sending domains yet"
				description="Add a domain and publish its DNS records to start sending from your own domain."
			>
				<template #action>
					<NuxtLink :to="DOMAIN_SETUP_ROUTE">
						<UiButton variant="secondary">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							Add a domain
						</UiButton>
					</NuxtLink>
				</template>
			</UiEmptyState>

			<div v-else class="divide-y divide-border-subtle">
				<div
					v-for="row in rows"
					:key="row.domain"
					class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<!-- Reputation-health dot (distinct from the verification chip). -->
							<span
								class="w-2 h-2 rounded-full shrink-0"
								:class="healthDotClass[riskTone(row.riskLevel)]"
								aria-hidden="true"
							/>
							<p
								class="truncate text-text-primary"
								:class="row.status === 'verified' ? 'font-medium' : 'font-semibold'"
							>
								{{ row.domain }}
							</p>
							<span
								class="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
								:class="healthChipClass[STATUS_META[row.status].tone]"
							>
								{{ STATUS_META[row.status].label }}
							</span>
						</div>
						<!-- Auth roll-up: one clean line when all pass, else name the gap + fix link -->
						<div class="mt-1 flex items-center gap-2 text-xs">
							<span v-if="row.missing.length === 0" class="text-success tabular-nums">
								SPF · DKIM · DMARC ✓
							</span>
							<template v-else>
								<span class="text-text-tertiary"> Missing {{ row.missing.join(', ') }} </span>
								<NuxtLink
									:to="{ path: DOMAIN_SETUP_ROUTE, query: { domain: row.domain } }"
									class="inline-flex items-center gap-0.5 text-brand font-medium hover:underline focus-visible:underline focus-visible:outline-none rounded-sm transition-colors duration-(--motion-fast)"
								>
									Fix
									<Icon name="lucide:arrow-right" class="w-3 h-3" />
								</NuxtLink>
							</template>
						</div>
					</div>
					<div class="text-xs text-text-tertiary tabular-nums shrink-0 text-right">
						<p>
							{{ formatNumber(row.sent30d) }} sent
							<span class="block text-[11px]">30d</span>
						</p>
						<!-- Per-domain reputation detail (only when there's in-window activity). -->
						<p v-if="row.bounceRate !== null" class="mt-1">
							{{ formatPercentage(row.bounceRate, 2) }} bounced ·
							{{ formatPercentage(row.complaintRate ?? 0, 2) }} complaints
						</p>
						<p
							v-if="row.spamRate !== null"
							class="mt-1"
							:class="
								row.spamRateStatus === 'hard_limit'
									? 'text-error'
									: row.spamRateStatus === 'elevated'
										? 'text-warning'
										: ''
							"
						>
							FBL spam {{ formatPercentage(row.spamRate, 3) }} · target &lt;
							{{ formatPercentage(PROVIDER_SPAM_RATE_POLICY.target, 1) }} · hard
							{{ formatPercentage(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1) }}
						</p>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
