<script setup lang="ts">
import { api } from '@owlat/api';
import type { ChartDatum } from '@owlat/ui/utils/chart';
import { deliveryVerdict, warmupSentence, deliveryStatTiles } from '~/utils/deliveryHub';
import { healthChipClass, levelTone } from '~/utils/healthTone';
import { formatDate } from '~/utils/formatters';

useHead({ title: 'Delivery health — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

const { isLoading: teamLoading } = useOrganizationContext();

// The SAME roll-up query that feeds the sidebar Delivery dot — so the header
// verdict chip and the nav dot can never disagree.
const { level, reason } = useDeliveryHealth();
const verdict = computed(() => deliveryVerdict(level.value));
const advancedOpen = ref(false);

// Sending overview: warm-up state, today's volume/budget, rolling reputation.
const {
	data: sendingOverview,
	isLoading: overviewLoading,
	error: overviewError,
} = useOrganizationQuery(api.analytics.reputationQueries.getSendingOverview);

// Domain table: every sending domain + auth summary + 30-day volume. The `error`
// travels with it for the same reason the Postmaster one does — the table's empty
// state is "No sending domains yet", with a link into the setup flow, and a read
// that failed has not established that.
const {
	data: domainRows,
	isLoading: domainsLoading,
	error: domainsError,
	refetch: refetchDomains,
} = useOrganizationQuery(api.analytics.reputationQueries.getDeliveryDomainTable);

// Google Postmaster Tools: additive-only, so an unconnected account renders a
// calm invitation rather than a warning. The `error` goes down with it — a
// faulted read must not render as "Not connected", which is a claim about the
// deployment this page has not been able to check.
const {
	data: postmasterStatus,
	isLoading: postmasterLoading,
	error: postmasterError,
} = useOrganizationQuery(api.delivery.postmaster.getPostmasterStatus);

// Delivery-rate history for the trend chart. The `error` travels with it for the
// same reason as the two above: an empty history renders "Collecting history —
// full trends in a week", which is a claim about how long this deployment has
// been sending, and a read that answered nothing has not established it.
const {
	data: snapshots,
	isLoading: snapshotsLoading,
	error: snapshotsError,
	refetch: refetchSnapshots,
} = useOrganizationQuery(api.analytics.reputationSnapshots.getDeliverySnapshots);

// Suppression roll-up (bounced/complained/manual/unengaged) for the summary line.
const { data: suppressionCounts } = useOrganizationQuery(api.blockedEmails.getCountsByReason);

const isLoading = computed(() => teamLoading.value || overviewLoading.value);

// --- Header warm-up sentence ---
const warmup = computed(() => warmupSentence(sendingOverview.value?.warming ?? null));

// --- Abuse status banner (preserved from the old sending-limits card) ---
const abuseWarning = computed(() => {
	const status = sendingOverview.value?.abuseStatus;
	if (!status || status === 'clean') return null;
	switch (status) {
		case 'warned':
			return {
				message:
					'Your account is flagged for elevated bounce or complaint rates. Improve list quality to avoid further restrictions.',
				severity: 'warning' as const,
			};
		case 'suspended':
			return {
				message:
					'Sending is suspended because reputation thresholds were exceeded. Resolve the flagged issues to resume.',
				severity: 'error' as const,
			};
		case 'banned':
			return {
				message: 'This account is permanently restricted from sending.',
				severity: 'error' as const,
			};
		default:
			return null;
	}
});

// --- Stat tiles ---
// Yesterday's rolling rates — the point just before the newest snapshot — so the
// bounce/complaint tiles can show a real day-over-day delta direction instead of
// a hardcoded one. `null` until at least two days of history exist — and `null`
// again when the history read faulted, which drops the delta off the tiles
// rather than drawing one against a day nobody could read.
const previousRates = computed(() => {
	const points = snapshots.value ?? [];
	const prev = points[points.length - 2];
	return prev ? { bounceRate: prev.bounceRate, complaintRate: prev.complaintRate } : null;
});

const statTiles = computed(() => {
	const overview = sendingOverview.value;
	const reputation = overview?.reputation
		? {
				bounceRate: overview.reputation.bounceRate,
				complaintRate: overview.reputation.complaintRate,
			}
		: null;
	const budget = overview?.warming
		? {
				totalSentToday: overview.warming.totalSentToday,
				totalDailyCap: overview.warming.totalDailyCap,
				remainingToday: overview.warming.remainingToday,
			}
		: null;
	return deliveryStatTiles(reputation, budget, previousRates.value);
});

const tileValueTone: Record<'ok' | 'warn' | 'error', 'default' | 'warning' | 'error'> = {
	ok: 'default',
	warn: 'warning',
	error: 'error',
};

// --- Trend chart ---
// The query already bounds itself to the last 30 daily points, so the chart is a
// true 30-day window (it can't silently grow to the 90-day retention horizon).
const trendData = computed<ChartDatum[]>(() =>
	(snapshots.value ?? []).map((s) => ({
		label: formatDate(s.periodStart, 'short'),
		value: s.deliveryRate,
	}))
);
const collectingHistory = computed(() => (snapshots.value?.length ?? 0) < 7);
function formatRate(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

// --- Suppressions summary line ---
const suppressionParts = computed(() => {
	const c = suppressionCounts.value;
	if (!c || c.total === 0) return null;
	const parts: string[] = [];
	if (c.bounced > 0) parts.push(`${c.bounced.toLocaleString()} bounced`);
	if (c.complained > 0) parts.push(`${c.complained.toLocaleString()} complained`);
	if (c.manual > 0) parts.push(`${c.manual.toLocaleString()} manual`);
	if (c.unengaged > 0) parts.push(`${c.unengaged.toLocaleString()} unengaged`);
	return { total: c.total, breakdown: parts.join(' · ') };
});

// Verdict chip tone → semantic token classes, via the shared health tone map so
// the chip and the sidebar dot (which reads the same query) can't drift apart.
const verdictChipClass = computed(() => healthChipClass[levelTone(verdict.value.tone)]);

// Warm-up detail for the depth-on-demand disclosure — only when the MTA has
// synced warming state (volume rides along so both are one narrowed object).
const sendingDetail = computed(() => {
	const o = sendingOverview.value;
	return o && o.warming ? { warming: o.warming, volume: o.volume } : null;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between gap-4">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:shield-check" size="lg" variant="brand" rounded="xl" />
				<div>
					<div class="flex items-center gap-2.5">
						<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">Delivery health</h1>
						<span
							class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
							:class="verdictChipClass"
						>
							{{ verdict.label }}
						</span>
					</div>
					<!-- When the verdict isn't Healthy, surface the reason as a visible
						 line (not just a mouse-only tooltip) so keyboard/touch users see it. -->
					<p v-if="level !== 'ok' && reason" class="mt-1 text-sm text-text-secondary">
						{{ reason }}
					</p>
					<p v-if="warmup" class="mt-1 text-sm text-text-secondary">{{ warmup }}</p>
					<p v-else-if="level === 'ok'" class="mt-1 text-sm text-text-secondary">
						Your sending reputation, delivery trend, and domains at a glance
					</p>
				</div>
			</div>
			<UiDisclosure
				v-model="advancedOpen"
				controls="delivery-advanced-links"
				label="Advanced tools"
			>
				<div class="flex flex-wrap justify-end gap-3">
					<NuxtLink
						to="/dashboard/admin/delivery/advanced/independence"
						class="text-sm text-brand hover:underline"
						>Independence</NuxtLink
					>
					<NuxtLink
						to="/dashboard/admin/delivery/advanced/cells"
						class="text-sm text-brand hover:underline"
						>Cells</NuxtLink
					>
					<NuxtLink
						to="/dashboard/admin/delivery/advanced/controls"
						class="text-sm text-brand hover:underline"
						>Controls</NuxtLink
					>
					<NuxtLink
						to="/dashboard/admin/delivery/advanced/measurement"
						class="text-sm text-brand hover:underline"
						>Measurement</NuxtLink
					>
				</div>
			</UiDisclosure>
		</div>

		<!-- The one readiness panel leads the hub: it derives a single truth for
			 "can this instance send?" from the real transport + domain + email-auth
			 state, so the two halves of go-live (a transport, a verified/authenticated
			 domain) meet in ONE place. The self-host onboarding banner defers its
			 pre-send steps here rather than re-listing them. -->
		<DeliveryReadinessPanel class="mb-6" />

		<!-- Transport detail below the readiness summary: which transport is live,
			 its recent runtime health, and the single "Change transport" action that
			 opens the in-app transport editor. -->
		<DeliveryTransportCard class="mb-6" />

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-text-tertiary" />
		</div>

		<UiErrorAlert
			v-else-if="overviewError"
			title="Couldn't load delivery health"
			message="We hit an error loading your reputation data. Reload to try again."
			class="my-8"
		/>

		<div v-else-if="sendingOverview" class="space-y-6">
			<!-- Abuse status banner (send-blocking / attention) -->
			<div
				v-if="abuseWarning"
				:class="
					abuseWarning.severity === 'error'
						? 'bg-error/10 border-error/20 text-error'
						: 'bg-warning/10 border-warning/20 text-warning'
				"
				class="flex items-start gap-3 p-4 rounded-lg border"
			>
				<Icon
					:name="
						abuseWarning.severity === 'error' ? 'lucide:alert-triangle' : 'lucide:alert-circle'
					"
					class="w-5 h-5 mt-0.5 shrink-0"
				/>
				<p class="text-sm">{{ abuseWarning.message }}</p>
			</div>

			<DeliveryComplianceTelemetryCard />

			<!-- Stat tiles: bounce / complaint / send budget — each with a real
				 day-over-day delta direction and its threshold as a muted hint. -->
			<UiCard>
				<div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
					<UiStatTile
						v-for="tile in statTiles"
						:key="tile.key"
						:label="tile.label"
						:value="tile.value"
						:delta="tile.delta"
						:delta-direction="tile.deltaDirection"
						:delta-tone="tile.deltaTone"
						:hint="tile.threshold"
						:value-tone="tileValueTone[tile.tone]"
					/>
				</div>
			</UiCard>

			<!-- Depth-on-demand: per-IP warm-up, total volume, last sync. -->
			<DeliverySendingDetails
				v-if="sendingDetail"
				:warming="sendingDetail.warming"
				:volume="sendingDetail.volume"
			/>

			<!-- 30-day delivery-rate trend -->
			<UiCard>
				<div class="space-y-3">
					<div class="flex items-center justify-between gap-3">
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Delivery rate</h2>
							<p class="text-sm text-text-secondary">
								Share of sent mail that was delivered, daily
							</p>
						</div>
					</div>
					<!-- Behind its own boundary: an empty history draws a flat chart under
						 "Collecting history — full trends in a week", which tells an operator
						 with three weeks of sending behind them that this deployment is new. -->
					<UiQueryBoundary
						:loading="snapshotsLoading"
						:error="snapshotsError"
						error-title="Couldn’t load your delivery-rate history"
						error-message="This trend could not be read. It is not shown empty: an empty chart here means you have only just started sending, and that is not something to claim while the read is failing."
						@retry="refetchSnapshots"
					>
						<template #loading>
							<div
								class="h-40 animate-pulse rounded-xl bg-bg-surface"
								role="status"
								aria-live="polite"
								aria-label="Loading delivery-rate history"
							/>
						</template>
						<UiTrendChart
							:data="trendData"
							:format-value="formatRate"
							aria-label="30-day delivery rate trend"
						/>
						<p v-if="collectingHistory" class="mt-3 text-xs text-text-tertiary">
							Collecting history — full trends in a week.
						</p>
					</UiQueryBoundary>
				</div>
			</UiCard>

			<DeliveryPostmasterComplianceCard
				:status="postmasterStatus"
				:is-loading="postmasterLoading"
				:error="postmasterError"
			/>

			<DeliveryMeasurementCoverageCard />

			<!-- Domain table. Behind its own boundary: an empty domain list here reads
				 "No sending domains yet — add a domain and publish its DNS records" and
				 points into the setup flow, which is a claim about the deployment that a
				 faulted read has not earned. -->
			<UiQueryBoundary
				:loading="domainsLoading"
				:error="domainsError"
				error-title="Couldn’t load your sending domains"
				error-message="This list could not be read. It is not shown empty: an empty list here means you have no sending domains set up, and that is not something to claim while the read is failing."
				@retry="refetchDomains"
			>
				<template #loading>
					<div
						class="h-40 animate-pulse rounded-xl bg-bg-surface"
						role="status"
						aria-live="polite"
						aria-label="Loading sending domains"
					/>
				</template>
				<DeliveryDomainTable :rows="domainRows ?? []" />
			</UiQueryBoundary>

			<!-- Quiet suppressions summary -->
			<NuxtLink
				v-if="suppressionParts"
				to="/dashboard/audience/suppressions"
				class="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-bg-surface hover:bg-bg-surface-hover transition-colors duration-(--motion-fast) group"
			>
				<div class="flex items-center gap-2 min-w-0">
					<Icon name="lucide:shield-off" class="w-4 h-4 text-text-tertiary shrink-0" />
					<p class="text-sm text-text-secondary truncate">
						<span class="text-text-primary font-medium tabular-nums">{{
							suppressionParts.total.toLocaleString()
						}}</span>
						suppressed · {{ suppressionParts.breakdown }}
					</p>
				</div>
				<span class="inline-flex items-center gap-0.5 text-sm text-brand font-medium shrink-0">
					View
					<Icon
						name="lucide:arrow-right"
						class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
					/>
				</span>
			</NuxtLink>
		</div>

		<!-- No settings found -->
		<UiEmptyState
			v-else
			icon="lucide:shield-check"
			title="No data available"
			description="Delivery health will appear once your workspace's sending is configured."
		/>
	</div>
</template>
