<script setup lang="ts">
/**
 * CELLS — the grid, and the evidence behind every verdict (plan D12, P3-6).
 *
 * The grid answers the four questions an operator has about a cell: what share
 * it carries, what state it is in, what is holding it back, and what the
 * controller last decided. Opening a cell answers the fifth — WHY — with the
 * gate-by-gate numbers from the measurement dashboard and the cell's full
 * decision history, including the no-ops.
 *
 * TWO READS, NOT ONE, AND DELIBERATELY SO. The ramp position comes from the
 * control query and the gate evidence from the shipped measurement dashboard;
 * merging them server-side would have made one screen's read the other's
 * dependency, and the measurement dashboard is the piece that must keep working
 * on its own.
 */
import { api } from '@owlat/api';
import { rampCellLabel, type RampCellControl } from '~/utils/deliverabilityRamp';
import type { DeliverabilityDashboardCell } from '~/utils/deliverabilityMeasurement';
import { decisionWindowLabel } from '~/utils/deliverabilityWindows';

useHead({ title: 'Delivery cells — Owlat' });

definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const {
	data: controls,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.rampControlQueries.getRampControls);
/**
 * The evidence read, WITH its own states. "No measurements have been recorded
 * for this cell yet. Nothing is wrong" is a verdict about the traffic, and a
 * faulted or in-flight read has no standing to give it — it is the calmest
 * possible sentence and it would be a lie exactly when something IS wrong.
 */
const {
	data: dashboard,
	isLoading: evidenceLoading,
	error: evidenceError,
	refetch: refetchEvidence,
} = useOrganizationQuery(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard);

const gridHeadingId = useId();
const evidenceHeadingId = useId();
const historyHeadingId = useId();

const selectedCellKey = ref<string | null>(null);

const cells = computed<readonly RampCellControl[]>(() => controls.value?.cells ?? []);

const selectedCell = computed<RampCellControl | null>(
	() => cells.value.find((cell) => cell.cellKey === selectedCellKey.value) ?? null
);

/** The measurement dashboard's view of the same cell, when it has one. */
const selectedEvidence = computed<DeliverabilityDashboardCell | null>(
	() => dashboard.value?.cells.find((cell) => cell.cellKey === selectedCellKey.value) ?? null
);
/**
 * The span those gate verdicts were decided over — the ramp controller's own,
 * which is exactly why this panel can stand beside the decision history without
 * the two disagreeing (#510). Named on screen rather than assumed: this page
 * shows no counters of its own, so a reader has nothing else to infer it from.
 */
const evidenceWindowLabel = computed(() => {
	const data = dashboard.value;
	return data ? decisionWindowLabel(data) : '';
});

const decisionArgs = computed(() => {
	const cell = selectedCell.value;
	return cell === null
		? null
		: { stream: cell.cell.stream, destinationProvider: cell.cell.destinationProvider };
});

const {
	data: decisions,
	isLoading: decisionsLoading,
	error: decisionsError,
	refetch: refetchDecisions,
} = useOrganizationQuery(
	api.delivery.rampControlQueries.listCellDecisions,
	// `undefined` means "not ready, do not subscribe" — the composable's own
	// contract. No cell is open, so there is nothing to ask for.
	() => decisionArgs.value ?? undefined
);

function select(cellKey: string): void {
	selectedCellKey.value = selectedCellKey.value === cellKey ? null : cellKey;
}
</script>

<template>
	<div class="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6">
			<h1 class="text-2xl font-semibold text-text-primary">Delivery cells</h1>
			<p class="mt-1 max-w-2xl text-sm text-text-secondary">
				Every stream and mailbox provider the ramp manages, what it is doing, and why. Open a cell
				for the numbers behind each check.
			</p>
		</header>

		<!-- Plan D8: with two reference relays there is no single second arm, so
		     every share below holds. The reason belongs on the screen where the
		     frozen share is watched, not only where relays are configured. -->
		<DeliveryReferenceRelayNotice class="mb-6" />

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			error-title="Couldn’t load the delivery cells"
			error-message="The cell states could not be loaded. Your mail is unaffected — this page only reads."
		>
			<template #loading>
				<div class="space-y-5" role="status" aria-live="polite" aria-label="Loading delivery cells">
					<div class="h-64 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div class="space-y-5">
				<UiCard>
					<h2 :id="gridHeadingId" class="text-base font-semibold text-text-primary">
						Stream × mailbox provider
					</h2>
					<DeliveryRampCellsGrid
						class="mt-3"
						:cells="cells"
						:selected-cell-key="selectedCellKey"
						:labelled-by="gridHeadingId"
						@select="select"
					/>
				</UiCard>

				<UiCard v-if="selectedCell">
					<h2 :id="evidenceHeadingId" class="text-base font-semibold text-text-primary">
						{{ rampCellLabel(selectedCell.cell) }} — the evidence
					</h2>
					<UiQueryBoundary
						:loading="evidenceLoading"
						:error="evidenceError"
						error-title="Couldn’t load this cell’s evidence"
						error-message="The gate readings could not be read. This is not a cell with nothing measured — the numbers simply did not load."
						@retry="refetchEvidence"
					>
						<template #loading>
							<div
								class="mt-3 h-24 animate-pulse rounded-lg bg-bg-surface"
								role="status"
								aria-live="polite"
								aria-label="Loading the evidence for this cell"
							/>
						</template>
						<DeliveryMeasurementGateList
							v-if="selectedEvidence"
							class="mt-3"
							:gates="selectedEvidence.gates"
							:failed-gate="selectedEvidence.failedGate"
							:requires-corroboration="selectedEvidence.requiresCorroboration"
							:decision-window-label="evidenceWindowLabel"
						/>
						<p v-else class="mt-3 text-sm text-text-secondary" data-testid="ramp-evidence-absent">
							No measurements have been recorded for this cell yet. Nothing is wrong — the checks
							fill in as mail goes out.
						</p>
					</UiQueryBoundary>
				</UiCard>

				<UiCard v-if="selectedCell">
					<h2 :id="historyHeadingId" class="text-base font-semibold text-text-primary">
						Decision history
					</h2>
					<UiQueryBoundary
						:loading="decisionsLoading"
						:error="decisionsError"
						error-title="Couldn’t load this cell’s decision history"
						error-message="The controller’s record for this cell could not be read. An empty timeline would say it has never looked at this cell, which is not what a failed read means."
						@retry="refetchDecisions"
					>
						<template #loading>
							<div
								class="mt-3 h-24 animate-pulse rounded-lg bg-bg-surface"
								role="status"
								aria-live="polite"
								aria-label="Loading the decision history for this cell"
							/>
						</template>
						<DeliveryRampDecisionTimeline
							class="mt-3"
							:decisions="decisions ?? []"
							:labelled-by="historyHeadingId"
						/>
					</UiQueryBoundary>
					<!-- This screen explains; the next one acts. An operator who has just
						 read why a cell is held is exactly the person about to change it. -->
					<NuxtLink
						to="/dashboard/delivery/controls"
						class="mt-4 inline-flex items-center gap-2 text-sm text-text-secondary transition-colors duration-(--motion-fast) hover:text-brand"
						data-testid="ramp-cells-controls-link"
					>
						<Icon name="lucide:sliders-horizontal" class="h-4 w-4" />
						Pause, pin or reset this cell
					</NuxtLink>
				</UiCard>
			</div>
		</UiQueryBoundary>
	</div>
</template>
