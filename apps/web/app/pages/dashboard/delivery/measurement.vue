<script setup lang="ts">
/**
 * Deliverability measurement — v1, READ-ONLY (plan D2, D5, D14).
 *
 * The measurement ships before the control. This page proves the signal is
 * trustworthy before anything acts on it: per cell, both arms' outcomes, every
 * gate's verdict with the numbers behind it, how much the measurement is worth,
 * and the trend across the window. There are no controls on this page and no
 * writes behind it; P3-6 adds the control surface.
 *
 * D14: with a reference transport the feature is "Sending independence"; with
 * none it is "Warm-up autopilot" — a different, honest feature, not a degraded
 * one. Either way, a fresh install with zero third-party credentials renders
 * this screen cleanly (plan D2).
 */
import { api } from '@owlat/api';
import {
	isZeroVolume,
	measurementHeadline,
	measurementSubhead,
	type DeliverabilityDashboardCell,
} from '~/utils/deliverabilityMeasurement';
import { formatShortDate } from '~/utils/formatters';

useHead({ title: 'Delivery measurement — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const {
	data: dashboard,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard);

const referenceTransportId = computed<string | null>(
	() => dashboard.value?.referenceTransportId ?? null
);
const headline = computed(() => measurementHeadline(referenceTransportId.value));
const subhead = computed(() => measurementSubhead(referenceTransportId.value));

/**
 * Cells with traffic first, quiet cells after — a quiet cell is still shown
 * (its emptiness is a fact about the account), it just does not lead.
 */
const cells = computed<DeliverabilityDashboardCell[]>(() => {
	const all = [...(dashboard.value?.cells ?? [])];
	return all.sort((a, b) => Number(isZeroVolume(a)) - Number(isZeroVolume(b)));
});

const windowLabel = computed(() => {
	const data = dashboard.value;
	if (!data) return '';
	// `windowEnd` is exclusive; the label names the last day actually included.
	return `${formatShortDate(data.windowStart)} – ${formatShortDate(data.windowEnd - 1)}`;
});
</script>

<template>
	<div class="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6 flex items-start gap-3">
			<UiIconBox icon="lucide:activity" size="lg" variant="brand" rounded="xl" />
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">{{ headline }}</h1>
				<p class="mt-1 max-w-2xl text-sm text-text-secondary">{{ subhead }}</p>
				<p v-if="windowLabel" class="mt-1 text-xs text-text-secondary">
					Window: <span data-testid="measurement-window">{{ windowLabel }}</span>
				</p>
			</div>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:empty="!dashboard"
			error-title="Couldn’t load delivery measurements"
			error-message="The sending measurements could not be loaded. Your mail is unaffected — this page only reads."
			loading-label="Loading delivery measurements…"
		>
			<template #loading>
				<div class="space-y-5" aria-label="Loading delivery measurements">
					<div class="h-56 animate-pulse rounded-xl bg-bg-surface" />
					<div class="h-56 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div class="space-y-5">
				<!-- Standalone is a supported configuration, stated plainly and once. -->
				<UiCard v-if="referenceTransportId === null">
					<p class="text-sm text-text-secondary" data-testid="measurement-standalone-note">
						You are sending entirely from your own server. Everything below is measured against your
						own history. Connecting a relay you already pay for would let the same traffic be
						compared side by side and raise measurement confidence — it is optional, and nothing
						here is waiting on it.
					</p>
				</UiCard>

				<DeliveryMeasurementCellCard
					v-for="cell in cells"
					:key="cell.cellKey"
					:cell="cell"
					:reference-transport-id="referenceTransportId"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
