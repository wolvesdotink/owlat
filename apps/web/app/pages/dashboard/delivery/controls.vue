<script setup lang="ts">
/**
 * CONTROLS — the human's hand on the ramp (plan D9, D12, D14, P3-6).
 *
 * Pause, pin, force-advance, reset to a phase, and the per-stream pace. Every
 * one of them goes through an org-scoped, admin-gated mutation and lands in the
 * audit trail; the retreats the controller made on its own are listed here too,
 * naming the check that broke and what to do about it (plan D12), because a
 * controller that silently retreats will be experienced as a bug.
 *
 * ONE WRITE CALL SITE PER CONTROL. The control components emit intent and this
 * page owns the mutations, so refusal handling is written once rather than five
 * times — and a control that cannot apply (a cell the ramp has not taken over)
 * says so calmly instead of failing.
 *
 * FORCE-ADVANCE IS THE ONLY ONE BEHIND A TYPED CONFIRMATION, because it is the
 * only one that can lose reputation. The phrase is checked again by the mutation,
 * so skipping this dialog does not skip the rule.
 */
import { api } from '@owlat/api';
import {
	FORCE_ADVANCE_CONFIRMATION,
	type RampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import { rampCellLabel, shareLabel, type RampCellControl } from '~/utils/deliverabilityRamp';

useHead({ title: 'Delivery controls — Owlat' });

definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const {
	data: controls,
	isLoading,
	error,
	refetch,
} = useOrganizationQuery(api.delivery.rampControlQueries.getRampControls);
const { data: notices } = useOrganizationQuery(
	api.delivery.rampControlQueries.listRampAdminNotices
);

const noticesHeadingId = useId();

const { run: setCellPause } = useBackendOperation(api.delivery.rampControls.setCellPause, {
	label: 'Pause ramp cell',
});
const { run: pinCellShare } = useBackendOperation(api.delivery.rampControls.pinCellShare, {
	label: 'Pin ramp cell',
});
const { run: forceAdvance } = useBackendOperation(api.delivery.rampControls.forceAdvanceCellShare, {
	label: 'Force-advance ramp cell',
});
const { run: resetPhase } = useBackendOperation(api.delivery.rampControls.resetCellPhase, {
	label: 'Reset ramp phase',
});
const { run: setStreamPreset } = useBackendOperation(api.delivery.rampControls.setStreamPreset, {
	label: 'Change ramp pace',
});

const selectedCellKey = ref<string | null>(null);
const pendingForceShare = ref<number | null>(null);

const cells = computed<readonly RampCellControl[]>(() => controls.value?.cells ?? []);
const selectedCell = computed<RampCellControl | null>(
	() => cells.value.find((cell) => cell.cellKey === selectedCellKey.value) ?? null
);

const streams = ['campaign', 'automation', 'transactional'] as const;
type RampStream = (typeof streams)[number];

function presetFor(stream: string): RampPreset | null {
	const stored = controls.value?.presets;
	if (stored === undefined) return null;
	return stored[stream] ?? null;
}

function cellArgs(cell: RampCellControl) {
	return { stream: cell.cell.stream, destinationProvider: cell.cell.destinationProvider };
}

async function pause(isPaused: boolean): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	await setCellPause({ ...cellArgs(cell), isPaused });
	await refetch();
}

async function pin(share: number | null): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	await pinCellShare({ ...cellArgs(cell), share });
	await refetch();
}

async function reset(phaseCeiling: number): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	await resetPhase({ ...cellArgs(cell), phaseCeiling });
	await refetch();
}

/** Force-advance NEVER writes from the button — it only opens the dialog. */
function requestForceAdvance(share: number): void {
	pendingForceShare.value = share;
}

async function confirmForceAdvance(confirmation: string): Promise<void> {
	const cell = selectedCell.value;
	const share = pendingForceShare.value;
	pendingForceShare.value = null;
	if (cell === null || share === null) return;
	await forceAdvance({ ...cellArgs(cell), share, confirmation });
	await refetch();
}

async function changePreset(stream: RampStream, preset: RampPreset | null): Promise<void> {
	await setStreamPreset({ stream, preset });
	await refetch();
}
</script>

<template>
	<div class="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6">
			<h1 class="text-2xl font-semibold text-text-primary">Delivery controls</h1>
			<p class="mt-1 max-w-2xl text-sm text-text-secondary">
				Hold a cell, cap it, push it, or start it over — and choose how hard each stream ramps.
				Everything here is recorded, including what the controller decided on its own.
			</p>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			error-title="Couldn’t load the delivery controls"
			error-message="The controls could not be loaded. Your mail is unaffected — nothing has changed."
		>
			<template #loading>
				<div
					class="space-y-5"
					role="status"
					aria-live="polite"
					aria-label="Loading delivery controls"
				>
					<div class="h-40 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div v-if="controls" class="space-y-5">
				<UiCard v-if="controls.isControllerPaused">
					<p class="text-sm text-text-secondary" data-testid="ramp-global-pause">
						The whole ramp is paused. Every cell is pinned where it is; the checks keep running so
						you can see what would have happened.
					</p>
				</UiCard>

				<UiCard>
					<h2 class="text-base font-semibold text-text-primary">Pick a cell</h2>
					<div class="mt-3 flex flex-wrap gap-2">
						<button
							v-for="cell in cells"
							:key="cell.cellKey"
							type="button"
							class="rounded-md border border-border-subtle px-2 py-1 text-sm"
							:aria-pressed="cell.cellKey === selectedCellKey"
							:data-testid="`ramp-select-${cell.cellKey}`"
							@click="selectedCellKey = cell.cellKey"
						>
							{{ rampCellLabel(cell.cell) }} · {{ shareLabel(cell.ownShare) }}
						</button>
					</div>
				</UiCard>

				<UiCard v-if="selectedCell">
					<DeliveryRampCellControls
						:cell="selectedCell"
						@pause="pause"
						@pin="pin"
						@force-advance="requestForceAdvance"
						@reset-phase="reset"
					/>
				</UiCard>

				<UiCard>
					<h2 class="text-base font-semibold text-text-primary">How hard to ramp</h2>
					<div class="mt-3 space-y-5">
						<DeliveryRampPresetPicker
							v-for="stream in streams"
							:key="stream"
							:stream="stream"
							:preset="presetFor(stream)"
							:default-preset="controls.defaultPreset"
							@change="(preset) => changePreset(stream, preset)"
						/>
					</div>
				</UiCard>

				<UiCard>
					<h2 :id="noticesHeadingId" class="text-base font-semibold text-text-primary">
						Automatic pull-backs
					</h2>
					<DeliveryRampDecreaseNotices
						class="mt-3"
						:notices="notices ?? []"
						:labelled-by="noticesHeadingId"
					/>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<DeliveryRampConfirmDialog
			:open="pendingForceShare !== null"
			title="Force this cell past the evidence?"
			:phrase="FORCE_ADVANCE_CONFIRMATION"
			confirm-label="Force-advance"
			@cancel="pendingForceShare = null"
			@confirm="confirmForceAdvance"
		>
			<template #consequence>
				<p data-testid="force-advance-consequence">
					This moves
					{{ selectedCell === null ? 'the cell' : rampCellLabel(selectedCell.cell) }} to
					{{ pendingForceShare === null ? '' : shareLabel(pendingForceShare) }} without any check
					agreeing to it. If the new volume is too much for that provider, the damage lands on your
					sending domain’s reputation and takes weeks to undo — putting the number back does not
					undo it.
				</p>
				<p>The clean streak restarts at zero, and the next evaluation will retreat if it is bad.</p>
			</template>
		</DeliveryRampConfirmDialog>
	</div>
</template>
