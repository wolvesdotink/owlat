<script setup lang="ts">
import { api } from '@owlat/api';

const { data: overview, isLoading } = useOrganizationQuery(
	api.analytics.reputationQueries.getSendingOverview
);

// NOTE: this card surfaces sending CAPACITY (IP-warming phase + daily-cap usage
// from the MTA warming state), not a delivery rate. The real, data-backed
// delivery rate lives on OrgReputationCard (reputation summary). These read the
// actual getSendingOverview shape ({ warming, volume, reputation, abuseStatus });
// a prior version read non-existent tier/dailyLimit/remaining fields through an
// `as unknown` cast, so the card always showed "New Sender" / "Unlimited".

const warming = computed(() => overview.value?.warming ?? null);
const phase = computed<string | null>(() => warming.value?.phase ?? null);

const tierLabel = computed(() => {
	const p = phase.value;
	switch (p) {
		case 'ramp':
			return 'Warming Up';
		case 'plateau':
			return 'Ramping';
		case 'graduated':
			return 'Fully Warmed';
		case null:
			return 'No IP Warming';
		default:
			return p;
	}
});

const tierVariant = computed<'neutral' | 'warning' | 'default' | 'success'>(() => {
	switch (phase.value) {
		case 'ramp':
			return 'warning';
		case 'plateau':
			return 'default';
		case 'graduated':
			return 'success';
		default:
			return 'neutral';
	}
});

const dailyLimit = computed(() => warming.value?.totalDailyCap ?? null);
const remaining = computed(() => warming.value?.remainingToday ?? null);

const usagePercent = computed(() => {
	const cap = dailyLimit.value;
	if (!cap || remaining.value === null) return 0;
	const used = cap - remaining.value;
	return Math.round((used / cap) * 100);
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:gauge" size="sm" variant="success" />
					<h3 class="text-sm font-semibold text-text-primary">Sending Capacity</h3>
				</div>
				<NuxtLink
					to="/dashboard/delivery"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					Details
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else-if="!overview" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No sending data available</p>
			</div>

			<div v-else>
				<div class="flex items-center gap-3 mb-4">
					<UiBadge :variant="tierVariant">{{ tierLabel }}</UiBadge>
				</div>

				<div v-if="dailyLimit !== null" class="mb-3">
					<div class="flex items-center justify-between mb-1">
						<span class="text-xs text-text-secondary">Daily Limit Usage</span>
						<span class="text-xs font-medium text-text-primary">{{ usagePercent }}%</span>
					</div>
					<UiProgressBar
						size="sm"
						:value="usagePercent"
						:variant="usagePercent >= 90 ? 'error' : usagePercent >= 70 ? 'warning' : 'success'"
						aria-label="Daily sending limit usage"
					/>
					<div class="flex items-center justify-between mt-1">
						<span class="text-xs text-text-tertiary">
							{{ remaining?.toLocaleString() }} remaining
						</span>
						<span class="text-xs text-text-tertiary">
							{{ dailyLimit.toLocaleString() }} limit
						</span>
					</div>
				</div>

				<div v-else class="rounded-lg bg-bg-surface px-3 py-2">
					<p class="text-sm font-medium text-text-primary">Unlimited sending</p>
					<p class="text-xs text-text-tertiary">No daily limit applied</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
