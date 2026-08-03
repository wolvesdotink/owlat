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
 * READING IS EVERYONE'S, WRITING IS THE ADMINS'. Both queries behind this screen
 * are all-members — what the ramp is doing and what it pulled back is not
 * privileged information — but every one of the five writes is an
 * `adminMutation`. Offering the controls to an editor is therefore offering a
 * button whose only possible answer is `forbidden`, so they are not rendered and
 * the screen says why instead. The cell picker is the selector for those writes,
 * so it goes with them — which is why the copy on this screen points a member at
 * the cells screen, where the same shares and every decision are all-members.
 */
import { api } from '@owlat/api';
import {
	FORCE_ADVANCE_CONFIRMATION,
	type RampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import type { DeliverabilityStream } from '@owlat/shared/deliverabilityRouting';
import {
	rampCellLabel,
	rampRefusalSentence,
	shareLabel,
	type RampCellControl,
	type RampControlRefusal,
} from '~/utils/deliverabilityRamp';

useHead({ title: 'Delivery controls — Owlat' });

definePageMeta({ layout: 'dashboard', middleware: 'auth' });

/**
 * TWO PERMISSION READS, DELIBERATELY. `canManageOrganization` is false until the
 * role RESOLVES, which is the safe direction for a control — a member never sees
 * a write button flash before it is taken away. `showAdminGate` only asserts
 * once the role has resolved to a non-admin, so the explanation below is not
 * shown to an admin during first paint.
 */
const { canManageOrganization, showAdminGate } = usePermissions();

const {
	data: controls,
	isLoading,
	error,
	refetch,
} = useOrganizationQuery(api.delivery.rampControlQueries.getRampControls);
/**
 * THE SECOND READ NEEDS ITS OWN BOUNDARY, because its empty state is
 * affirmatively GOOD NEWS. "Nothing has been pulled back" under a faulted query
 * tells an operator the controller has not retreated when nobody knows whether
 * it has — the one place on this screen where a lost read reads as reassurance.
 */
const {
	data: notices,
	isLoading: noticesLoading,
	error: noticesError,
	refetch: refetchNotices,
} = useOrganizationQuery(api.delivery.rampControlQueries.listRampAdminNotices);

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
	() => isPausing.value || isPinning.value || isForcing.value || isResetting.value
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

function noteResult(result: { readonly refusal?: RampControlRefusal } | undefined): void {
	refusal.value = result?.refusal ?? null;
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
	refusal.value = null;
}

function presetFor(stream: DeliverabilityStream): RampPreset | null {
	return controls.value?.presets[stream] ?? null;
}

function cellArgs(cell: RampCellControl) {
	return { stream: cell.cell.stream, destinationProvider: cell.cell.destinationProvider };
}

async function pause(isPaused: boolean): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	refusal.value = null;
	noteResult(await setCellPause({ ...cellArgs(cell), isPaused }));
	refetch();
}

async function pin(share: number | null): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	refusal.value = null;
	noteResult(await pinCellShare({ ...cellArgs(cell), share }));
	refetch();
}

async function reset(phaseCeiling: number): Promise<void> {
	const cell = selectedCell.value;
	if (cell === null) return;
	refusal.value = null;
	noteResult(await resetPhase({ ...cellArgs(cell), phaseCeiling }));
	refetch();
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
	refusal.value = null;
	noteResult(await forceAdvance({ ...cellArgs(cell), share, confirmation }));
	refetch();
}

async function changePreset(
	stream: DeliverabilityStream,
	preset: RampPreset | null
): Promise<void> {
	refusal.value = null;
	await setStreamPreset({ stream, preset });
	refetch();
}
</script>

<template>
	<div class="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6">
			<h1 class="text-2xl font-semibold text-text-primary">Delivery controls</h1>
			<!-- The action clause is the header's half of the admin gate: promising
			     "hold a cell, cap it, push it" to a member who is about to read that
			     they may do none of those leaves the lede as the last surface still
			     offering the buttons the gate takes away. The neutral sentence is
			     true for everyone, so the clause is ADDED for an admin rather than
			     swapped — an unresolved role never watches the lede rewrite itself.
			     The neutral sentence therefore covers the pull-backs ONLY: every
			     per-cell share lives in the cell picker, which is behind the same
			     gate, so promising them to a member promises a list they cannot see. -->
			<p class="mt-1 max-w-2xl text-sm text-text-secondary">
				What the ramp pulled back on its own, and why.
				<span v-if="canManageOrganization" data-testid="ramp-controls-lede-actions">
					What each stream is carrying is here too — hold a cell, cap it, push it, or start it over,
					and choose how hard each stream ramps.
				</span>
				Everything here is recorded.
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

				<!-- Not a nag and not an error: what an editor is missing is the hand on
				     the ramp, not the sight of it. The gate takes the cell picker with
				     it, though, so the sentence claims only what is left HERE and sends
				     the reader to the screen that shows every cell's share and decision
				     history to all members — the mirror of the cells screen's own link
				     to this one. "Everything the controller is doing is shown below"
				     would be true of the admin's page and false of the one being read. -->
				<UiCard v-if="showAdminGate">
					<p class="text-sm text-text-secondary" data-testid="ramp-controls-admin-only">
						Changing the ramp — holding a cell, capping it, pushing it, or choosing a pace — is
						limited to workspace owners and admins. What the controller pulled back on its own is
						still shown below.
					</p>
					<NuxtLink
						to="/dashboard/delivery/cells"
						class="mt-3 inline-flex items-center gap-2 text-sm text-text-secondary transition-colors duration-(--motion-fast) hover:text-brand"
						data-testid="ramp-controls-cells-link"
					>
						<Icon name="lucide:grid-3x3" class="h-4 w-4" />
						See what each cell is carrying
					</NuxtLink>
				</UiCard>

				<UiCard v-if="canManageOrganization">
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

				<UiCard v-if="canManageOrganization && selectedCell">
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
						@pause="pause"
						@pin="pin"
						@force-advance="requestForceAdvance"
						@reset-phase="reset"
					/>
					<p
						v-if="refusal"
						class="mt-3 text-sm text-text-secondary"
						data-testid="ramp-control-refusal"
						role="status"
					>
						{{ rampRefusalSentence(refusal) }}
					</p>
				</UiCard>

				<UiCard v-if="canManageOrganization">
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
					<UiQueryBoundary
						:loading="noticesLoading"
						:error="noticesError"
						error-title="Couldn’t load the automatic pull-backs"
						error-message="This list could not be read. It is not shown empty: an empty list here means the controller has pulled nothing back, and that is not something to claim while the read is failing."
						@retry="refetchNotices"
					>
						<template #loading>
							<div
								class="mt-3 h-16 animate-pulse rounded-lg bg-bg-surface"
								role="status"
								aria-live="polite"
								aria-label="Loading automatic pull-backs"
							/>
						</template>
						<DeliveryRampDecreaseNotices
							class="mt-3"
							:notices="notices ?? []"
							:labelled-by="noticesHeadingId"
						/>
					</UiQueryBoundary>
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
