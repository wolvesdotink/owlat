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
 *
 * TWO MOVES THIS PAGE OWNS THAT THE CONTROLS ARE NOT: putting a cell ON the ramp
 * (nothing else ever writes a cell's first share) and PROMOTING a phase, which is
 * the one door a ceiling rises through. A reset can only take a rung down.
 */
import { api } from '@owlat/api';
import {
	FORCE_ADVANCE_CONFIRMATION,
	type RampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import type { DeliverabilityStream } from '@owlat/shared/deliverabilityRouting';
import {
	rampCellLabel,
	rampEnrolledSentence,
	rampPromotionConditionLabel,
	rampPromotionSentence,
	rampRefusalSentence,
	shareLabel,
	type RampCellControl,
	type RampControlRefusal,
	type RampPromotionCondition,
} from '~/utils/deliverabilityRamp';

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

const { run: setCellPause, isLoading: isPausing } = useBackendOperation(
	api.delivery.rampControls.setCellPause,
	{ label: 'Pause ramp cell' }
);
const { run: pinCellShare, isLoading: isPinning } = useBackendOperation(
	api.delivery.rampControls.pinCellShare,
	{ label: 'Pin ramp cell' }
);
const { run: forceAdvance, isLoading: isForcing } = useBackendOperation(
	api.delivery.rampControls.forceAdvanceCellShare,
	{ label: 'Force-advance ramp cell' }
);
const { run: resetPhase, isLoading: isResetting } = useBackendOperation(
	api.delivery.rampControls.resetCellPhase,
	{ label: 'Reset ramp phase' }
);
const { run: enrollCell, isLoading: isEnrolling } = useBackendOperation(
	api.delivery.rampEnrollment.enrollCell,
	{ label: 'Put a cell on the ramp' }
);
const { run: promotePhase, isLoading: isPromoting } = useBackendOperation(
	api.delivery.rampPhasePromotion.promoteCellPhase,
	{ label: 'Promote ramp phase' }
);
const { run: setStreamPreset, isLoading: isChangingPreset } = useBackendOperation(
	api.delivery.rampControls.setStreamPreset,
	{ label: 'Change ramp pace' }
);

/**
 * ONE MUTATION IN FLIGHT AT A TIME. The four cell controls share one card and
 * one row, so leaving them all live while any of them is writing invites a
 * double submit against a row that is about to change under it.
 */
const isCellBusy = computed(
	() =>
		isPausing.value ||
		isPinning.value ||
		isForcing.value ||
		isResetting.value ||
		isEnrolling.value ||
		isPromoting.value
);

/**
 * THE REFUSAL IS PART OF THE ANSWER, not an error path. Every control mutation
 * can answer `{applied: false, refusal}` — the ramp is globally paused, a safety
 * hold stands, the cell is not managed yet — and an operator who sees nothing
 * happen and no sentence has been told the system is broken.
 *
 * Cleared at the START of every attempt so a stale sentence can never sit next
 * to a control that has since succeeded.
 */
const refusal = ref<RampControlRefusal | null>(null);

/**
 * AND SO IS THE ANSWER WHEN THERE IS NO REFUSAL.
 *
 * Pause, pin, force-advance and reset all change a number the operator typed and
 * can see on the card afterwards. The other two do not: the SETUP FORK is
 * resolved server-side and never chosen here, so which ramp an enrolment opened
 * — a sliver against the relay, or the whole cell with the pace as the dial — is
 * knowable nowhere else; and a promotion at the top rung is a real answer
 * ("nothing to promote") that carries no refusal, so without this it is a click
 * with no visible effect at all.
 */
const outcome = ref<string | null>(null);

function noteResult(result: { readonly refusal?: RampControlRefusal } | undefined): void {
	refusal.value = result?.refusal ?? null;
}

/**
 * WHAT THE NEXT RUNG IS STILL WAITING ON, kept beside the refusal that named it.
 * "Not yet" with no list is the shape of an unactionable refusal (plan D12/D14).
 */
const outstanding = ref<readonly RampPromotionCondition[]>([]);

/**
 * Cleared at the START of every attempt, all three together: a sentence from the
 * last write sitting beside the result of this one is worse than no sentence.
 */
function beginWrite(): void {
	refusal.value = null;
	outcome.value = null;
	outstanding.value = [];
}

const selectedCellKey = ref<string | null>(null);
const pendingForceShare = ref<number | null>(null);

const cells = computed<readonly RampCellControl[]>(() => controls.value?.cells ?? []);
const selectedCell = computed<RampCellControl | null>(
	() => cells.value.find((cell) => cell.cellKey === selectedCellKey.value) ?? null
);

// The closed stream union, so a typo here is a build failure rather than a
// preset card that silently never matches a stored row.
const streams: readonly DeliverabilityStream[] = ['campaign', 'automation', 'transactional'];

function selectCell(cellKey: string): void {
	selectedCellKey.value = cellKey;
	beginWrite();
}

function presetFor(stream: DeliverabilityStream): RampPreset | null {
	return controls.value?.presets[stream] ?? null;
}

function cellArgs(cell: RampCellControl) {
	return { stream: cell.cell.stream, destinationProvider: cell.cell.destinationProvider };
}

async function enroll(): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	beginWrite();
	const result = await enrollCell(cellArgs(cell));
	noteResult(result);
	// WHICH RAMP THE CELL GOT. The fork is resolved server-side, so the answer
	// travels back on the result and nowhere else — see `rampEnrolledSentence`.
	if (result?.enrolled === true && result.share !== undefined && result.path !== undefined) {
		outcome.value = rampEnrolledSentence(result.share, result.path);
	}
	await refetch();
}

async function promote(): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	beginWrite();
	const result = await promotePhase(cellArgs(cell));
	noteResult(result);
	outstanding.value = result?.outstanding ?? [];
	// THE TOP RUNG IS AN ANSWER, NOT A REFUSAL — `{applied: false}` with no
	// `refusal` and the rung the cell is already on. Rendered rather than
	// swallowed: a click that produces nothing at all reads as a broken button.
	if (result?.refusal === undefined && result?.phaseCeiling !== undefined) {
		outcome.value = rampPromotionSentence(result.applied, result.phaseCeiling);
	}
	await refetch();
}

async function pause(isPaused: boolean): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	beginWrite();
	noteResult(await setCellPause({ ...cellArgs(cell), isPaused }));
	await refetch();
}

async function pin(share: number | null): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	beginWrite();
	noteResult(await pinCellShare({ ...cellArgs(cell), share }));
	await refetch();
}

async function reset(phaseCeiling: number): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	beginWrite();
	noteResult(await resetPhase({ ...cellArgs(cell), phaseCeiling }));
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
	beginWrite();
	noteResult(await forceAdvance({ ...cellArgs(cell), share, confirmation }));
	await refetch();
}

async function changePreset(
	stream: DeliverabilityStream,
	preset: RampPreset | null
): Promise<void> {
	beginWrite();
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
							@click="selectCell(cell.cellKey)"
						>
							{{ rampCellLabel(cell.cell) }} · {{ shareLabel(cell.ownShare) }}
						</button>
					</div>
				</UiCard>

				<UiCard v-if="selectedCell">
					<!--
						KEYED BY CELL. Without it Vue reuses the instance across a change of
						selection and the pin/force number inputs keep the previous cell's
						values — the destructive control would then propose a share the
						operator chose for a different cell.
					-->
					<DeliveryRampCellControls
						:key="selectedCell.cellKey"
						:cell="selectedCell"
						:busy="isCellBusy"
						@enroll="enroll"
						@pause="pause"
						@pin="pin"
						@force-advance="requestForceAdvance"
						@reset-phase="reset"
						@promote-phase="promote"
					/>
					<p
						v-if="refusal"
						class="mt-3 text-sm text-text-secondary"
						data-testid="ramp-control-refusal"
						role="status"
					>
						{{ rampRefusalSentence(refusal) }}
					</p>
					<!--
						THE ANSWER WHEN THERE WAS NO REFUSAL, in the same slot and the same
						calm tone. Enrolment's fork is resolved server-side and a promotion at
						the top rung moves nothing, so both are writes whose only other
						evidence would be a screen that looks the same afterwards.
					-->
					<p
						v-if="outcome"
						class="mt-3 text-sm text-text-secondary"
						data-testid="ramp-control-outcome"
						role="status"
					>
						{{ outcome }}
					</p>
					<!--
						WHAT WOULD UNLOCK THE NEXT RUNG, beside the refusal that named it: a
						"not yet" with no list is a refusal an operator cannot act on.
					-->
					<ul
						v-if="outstanding.length > 0"
						class="mt-2 list-disc pl-5 text-sm text-text-secondary"
						data-testid="ramp-promotion-outstanding"
					>
						<li v-for="condition in outstanding" :key="condition">
							{{ rampPromotionConditionLabel(condition) }}
						</li>
					</ul>
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
							:has-reference-arm="controls.referenceTransportId !== null"
							:busy="isChangingPreset"
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
