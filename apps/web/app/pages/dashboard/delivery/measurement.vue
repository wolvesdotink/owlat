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
 * D14: with a reference arm the feature is "Sending independence"; with none it
 * is "Warm-up autopilot" — a different, honest feature, not a degraded one.
 * Either way, a fresh install with zero third-party credentials renders this
 * screen cleanly (plan D2).
 *
 * THE FRAMING IS KEYED TO THE CELLS, NOT TO THE RELAY LIST. Whether a cell has a
 * second arm is a MEASUREMENT the server already made — `cell.reference`, the
 * same fact the cards render and the gates were graded on. Keyed to
 * `referenceTransportId` instead, a deployment relaying through two kinds (which
 * has no single relay to NAME) was told "you are sending entirely from your own
 * server" directly above a card with a relay column in it. That id is kept for
 * the one thing it answers: what to CALL the second arm.
 *
 * THE OFFER IS THE EXCEPTION, AND IT IS NOT ONE. "Connect a relay you already
 * pay for" is advice about the DEPLOYMENT, so it is keyed to `isRelayConfigured`
 * — offered on a measurement, it appeared above a card explaining that this
 * deployment's relay had gone quiet. Same split as `dashboardConfidence` makes
 * for the per-cell offer: framing from the cells, offer from the relay list.
 *
 * AND THE PAGE NAMES BOTH SPANS. What the cards COUNT is the reported window;
 * what their checks DECIDED on is the ramp controller's own window, which is what
 * makes the verdicts here the ones the cron reached (#510). Both labels are in
 * the heading, and the deciding one travels down to every card.
 */
import { api } from '@owlat/api';
import {
	isZeroVolume,
	measurementHeadline,
	measurementSubhead,
	standaloneNote,
	type DeliverabilityDashboardCell,
} from '~/utils/deliverabilityMeasurement';
import { decisionWindowLabel, reportedWindowLabel } from '~/utils/deliverabilityWindows';

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

/** CONFIGURATION, and used for exactly one thing: naming the second arm. */
const referenceTransportId = computed<string | null>(
	() => dashboard.value?.referenceTransportId ?? null
);
/**
 * CONFIGURATION, the other reading of the same list: does a relay exist at all.
 * The only thing keyed to it is the offer to connect one — advice about the
 * deployment that nobody with a relay connected can act on.
 */
const isRelayConfigured = computed(() => dashboard.value?.isRelayConfigured ?? false);
/**
 * MEASUREMENT: did anything below actually get compared against a second arm?
 * One cell is enough — the page frames the screen, and a screen with a relay
 * column anywhere on it is not a standalone deployment.
 */
const hasReferenceArm = computed(() =>
	(dashboard.value?.cells ?? []).some((cell) => cell.reference !== null)
);
const headline = computed(() => measurementHeadline(hasReferenceArm.value));
const subhead = computed(() =>
	measurementSubhead({
		hasReferenceArm: hasReferenceArm.value,
		referenceTransportId: referenceTransportId.value,
	})
);
/**
 * MEASUREMENT, over the days the cards PLOT rather than the span the gates were
 * graded on. The note's closing sentence promises bars on the cards below, and
 * the same relay can be quiet for the controller's ~24h span while its bars
 * remain in a seven-day trend — or be absent from both, which is the ordinary
 * shape of a graduated deployment, a relay connected today, and a relay enabled
 * only for streams outside this screen. Same predicate the card guards its own
 * line with, asked across every cell.
 */
const hasPlottedRelayHistory = computed(() =>
	(dashboard.value?.cells ?? []).some((cell) =>
		cell.trend.some((point) => point.reference !== null)
	)
);
/**
 * The note is shown on the MEASUREMENT and worded on the CONFIGURATION: a relay
 * that merely went quiet gets the explanation the cards give, never an offer to
 * connect the relay it already has.
 */
const standaloneCopy = computed(() =>
	standaloneNote({
		isRelayConfigured: isRelayConfigured.value,
		referenceTransportId: referenceTransportId.value,
		hasPlottedRelayHistory: hasPlottedRelayHistory.value,
	})
);

/**
 * Cells with traffic first, quiet cells after — a quiet cell is still shown
 * (its emptiness is a fact about the account), it just does not lead.
 */
const cells = computed<DeliverabilityDashboardCell[]>(() => {
	const all = [...(dashboard.value?.cells ?? [])];
	return all.sort((a, b) => Number(isZeroVolume(a)) - Number(isZeroVolume(b)));
});

/**
 * THE TWO SPANS, NAMED SEPARATELY (#510). The counters, the trend and the arm
 * columns are over the REPORTED window; every check on every card was decided
 * over the ramp controller's own, shorter one. One heading over both would put a
 * week's dates above numbers reached over a day — the disagreement the server
 * just closed, re-opened as a caption.
 */
const windowLabel = computed(() => {
	const data = dashboard.value;
	return data ? reportedWindowLabel(data) : '';
});
const decisionLabel = computed(() => {
	const data = dashboard.value;
	return data ? decisionWindowLabel(data) : '';
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
					Reported window: <span data-testid="measurement-window">{{ windowLabel }}</span> · checks
					decided over
					<span data-testid="measurement-decision-window">{{ decisionLabel }}</span>
				</p>
			</div>
		</header>

		<!--
			No `empty` binding: the query always answers with the full cell product,
			and a cell nobody has sent through renders as its own calm empty state
			rather than as the boundary's generic "nothing to show" (plan D2/D14).
		-->
		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			error-title="Couldn’t load delivery measurements"
			error-message="The sending measurements could not be loaded. Your mail is unaffected — this page only reads."
		>
			<template #loading>
				<!--
					`role="status"` is what makes the name announceable: `aria-label` on a
					bare div (role=generic) is ignored by assistive technology.
				-->
				<div
					class="space-y-5"
					role="status"
					aria-live="polite"
					aria-label="Loading delivery measurements"
				>
					<div class="h-56 animate-pulse rounded-xl bg-bg-surface" />
					<div class="h-56 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div class="space-y-5">
				<!--
					Standalone is a supported configuration, stated plainly and once —
					and stated only where the cards below agree with it. The WORDS come
					from `standaloneNote`, because which of the two sentences applies is
					a question about the relay list rather than about this window.
				-->
				<UiCard v-if="!hasReferenceArm">
					<p class="text-sm text-text-secondary" data-testid="measurement-standalone-note">
						{{ standaloneCopy }}
					</p>
				</UiCard>

				<DeliveryMeasurementCellCard
					v-for="cell in cells"
					:key="cell.cellKey"
					:cell="cell"
					:reference-transport-id="referenceTransportId"
					:decision-window-label="decisionLabel"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
