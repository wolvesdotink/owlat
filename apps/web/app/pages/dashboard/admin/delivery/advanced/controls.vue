<script setup lang="ts">
/**
 * CONTROLS — the human's hand on the ramp (plan D9, D12, D14, P3-6).
 *
 * Enrol a cell, pause it, pin it, force-advance it, reset or promote its phase,
 * and set the per-stream pace. Every one of them goes through an org-scoped,
 * admin-gated mutation and lands in the audit trail; the retreats the controller
 * made on its own are listed here too, naming the check that broke and what to
 * do about it (plan D12), because a silent retreat will be reported as a bug.
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
 *
 * WRITING IS THE ADMINS', AND THE ROUTE IS WHAT SAYS SO. Every write here is an
 * `adminMutation`, enrolment and promotion included, and the `admin` route
 * middleware below is what enforces that on the way in: it waits for the role and
 * redirects a non-admin to /dashboard before this page renders. So this screen is
 * written for an admin reader throughout — an in-template "admins only" branch
 * would be unreachable, and the copy does not have to hedge about controls that
 * are always offered. The all-members view of the same shares and decisions lives
 * on the cells screen, which is where a member who followed a link here lands.
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

const { t } = useI18n();

/**
 * `utils/deliverabilityRamp` is a module-scope definition set whose sentences
 * carry i18n keys rather than sentences (the registry convention); a plain string
 * is still accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

useHead({ title: () => t('dashboard.admin.delivery.advanced.controls.pageTitle') });

definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

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
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.pause') }
);
const { run: pinCellShare, isLoading: isPinning } = useBackendOperation(
	api.delivery.rampControls.pinCellShare,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.pin') }
);
const { run: forceAdvance, isLoading: isForcing } = useBackendOperation(
	api.delivery.rampControls.forceAdvanceCellShare,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.forceAdvance') }
);
const { run: resetPhase, isLoading: isResetting } = useBackendOperation(
	api.delivery.rampPhaseReset.resetCellPhase,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.resetPhase') }
);
const { run: enrollCell, isLoading: isEnrolling } = useBackendOperation(
	api.delivery.rampEnrollment.enrollCell,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.enroll') }
);
const { run: promotePhase, isLoading: isPromoting } = useBackendOperation(
	api.delivery.rampPhasePromotion.promoteCellPhase,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.promote') }
);
const { run: setStreamPreset, isLoading: isChangingPreset } = useBackendOperation(
	api.delivery.rampControls.setStreamPreset,
	{ label: () => t('dashboard.admin.delivery.advanced.controls.operations.setPreset') }
);

/**
 * ONE MUTATION IN FLIGHT AT A TIME. The cell controls share one card and one
 * row, so leaving them all live while any of them is writing invites a double
 * submit against a row that is about to change under it.
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

/**
 * THE SHAPE EVERY PER-CELL WRITE SHARES: the selected cell or nothing, the slate
 * cleared BEFORE the attempt, the refusal kept, the read refreshed. Held once
 * rather than copied six times — a control that keeps its own copy and drops the
 * clear leaves the previous write's sentence beside this one's result.
 *
 * The result comes back for the two writes whose answer is not visible on the
 * card afterwards; the other four have nothing to add to it.
 */
async function writeSelectedCell<T extends { readonly refusal?: RampControlRefusal }>(
	write: (cell: RampCellControl) => Promise<BackendOperationResult<T>>
): Promise<T | undefined> {
	const cell = selectedCell.value;
	if (cell === null) return undefined;
	beginWrite();
	const written = await write(cell);
	const result = written.ok ? written.result : undefined;
	refusal.value = result?.refusal ?? null;
	refetch();
	return result;
}

async function enroll(): Promise<void> {
	// WHICH RAMP THE CELL GOT, AND WHETHER ANY MAIL FOLLOWS THE SHARE YET. Both
	// are resolved server-side, so the answer travels back on the result and
	// nowhere else — see `rampEnrolledSentence`.
	const result = await writeSelectedCell((cell) => enrollCell(cellArgs(cell)));
	if (
		result?.enrolled === true &&
		result.share !== undefined &&
		result.path !== undefined &&
		result.isShareRouted !== undefined
	) {
		outcome.value = localized(
			rampEnrolledSentence(result.share, result.path, result.isShareRouted)
		);
	}
}

async function promote(): Promise<void> {
	const result = await writeSelectedCell((cell) => promotePhase(cellArgs(cell)));
	outstanding.value = result?.outstanding ?? [];
	// THE TOP RUNG IS AN ANSWER, NOT A REFUSAL — `{applied: false}` with no
	// `refusal` and the rung the cell is already on. Rendered rather than
	// swallowed: a click that produces nothing at all reads as a broken button.
	// Absent view means absent relay: the cautious sentence claims less.
	if (result?.refusal === undefined && result?.phaseCeiling !== undefined) {
		const hasRelay = controls.value?.isRelayConfigured === true;
		outcome.value = localized(rampPromotionSentence(result.applied, result.phaseCeiling, hasRelay));
	}
}

async function pause(isPaused: boolean): Promise<void> {
	await writeSelectedCell((cell) => setCellPause({ ...cellArgs(cell), isPaused }));
}

async function pin(share: number | null): Promise<void> {
	await writeSelectedCell((cell) => pinCellShare({ ...cellArgs(cell), share }));
}

async function reset(phaseCeiling: number): Promise<void> {
	await writeSelectedCell((cell) => resetPhase({ ...cellArgs(cell), phaseCeiling }));
}

/** Force-advance NEVER writes from the button — it only opens the dialog. */
function requestForceAdvance(share: number): void {
	pendingForceShare.value = share;
}

async function confirmForceAdvance(confirmation: string): Promise<void> {
	const share = pendingForceShare.value;
	// The dialog closes on either answer: a share that never arrived is not a
	// dialog left open over a write that will not happen.
	pendingForceShare.value = null;
	if (share === null) return;
	await writeSelectedCell((cell) => forceAdvance({ ...cellArgs(cell), share, confirmation }));
}

async function changePreset(
	stream: DeliverabilityStream,
	preset: RampPreset | null
): Promise<void> {
	beginWrite();
	await setStreamPreset({ stream, preset });
	refetch();
}
</script>

<template>
	<div class="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.delivery.advanced.controls.title') }}
			</h1>
			<!-- The action clause used to be conditional, as the header's half of an
			     in-template admin gate. The `admin` route middleware means every
			     reader of this page is an admin, so the lede promises the controls
			     unconditionally — and cannot rewrite itself mid-paint. -->
			<p class="mt-1 max-w-2xl text-sm text-text-secondary">
				{{ t('dashboard.admin.delivery.advanced.controls.ledeIntro') }}
				<span data-testid="ramp-controls-lede-actions">
					{{ t('dashboard.admin.delivery.advanced.controls.ledeActions') }}
				</span>
				{{ t('dashboard.admin.delivery.advanced.controls.ledeRecorded') }}
			</p>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:error-title="t('dashboard.admin.delivery.advanced.controls.errorTitle')"
			:error-message="t('dashboard.admin.delivery.advanced.controls.errorMessage')"
		>
			<template #loading>
				<div
					class="space-y-5"
					role="status"
					aria-live="polite"
					:aria-label="t('dashboard.admin.delivery.advanced.controls.loading')"
				>
					<div class="h-40 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div v-if="controls" class="space-y-5">
				<UiCard v-if="controls.isControllerPaused">
					<p class="text-sm text-text-secondary" data-testid="ramp-global-pause">
						{{ t('dashboard.admin.delivery.advanced.controls.globalPause') }}
					</p>
				</UiCard>

				<UiCard>
					<h2 class="text-base font-semibold text-text-primary">
						{{ t('dashboard.admin.delivery.advanced.controls.pickCell') }}
					</h2>
					<div class="mt-3 flex flex-wrap gap-2">
						<UiButton
							v-for="cell in cells"
							:key="cell.cellKey"
							variant="outline"
							size="sm"
							:aria-pressed="cell.cellKey === selectedCellKey"
							:data-testid="`ramp-select-${cell.cellKey}`"
							@click="selectCell(cell.cellKey)"
						>
							{{ localized(rampCellLabel(cell.cell)) }} · {{ shareLabel(cell.ownShare) }}
						</UiButton>
					</div>
				</UiCard>

				<UiCard v-if="selectedCell">
					<!--
						KEYED BY CELL. Without it Vue reuses the instance across a change of
						selection and the pin/force number inputs keep the previous cell's
						values — the destructive control would then propose a share the
						operator chose for a different cell.
					-->
					<!--
						AND THE FACT THE SERVER CUTS ON, not the one the preset picker gets: a
						rung bounds the SHARE dial, and `referenceTransportId` is null on a
						deployment with TWO relays, where the server does cut. Reading it here
						promised that operator the 75% move would not happen.
					-->
					<DeliveryRampCellControls
						:key="selectedCell.cellKey"
						:cell="selectedCell"
						:has-relay-configured="controls.isRelayConfigured"
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
						{{ localized(rampRefusalSentence(refusal)) }}
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
							{{ localized(rampPromotionConditionLabel(condition)) }}
						</li>
					</ul>
				</UiCard>

				<UiCard>
					<h2 class="text-base font-semibold text-text-primary">
						{{ t('dashboard.admin.delivery.advanced.controls.howHard') }}
					</h2>
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
						{{ t('dashboard.admin.delivery.advanced.controls.pullBacks') }}
					</h2>
					<UiQueryBoundary
						:loading="noticesLoading"
						:error="noticesError"
						:error-title="t('dashboard.admin.delivery.advanced.controls.pullBacksErrorTitle')"
						:error-message="t('dashboard.admin.delivery.advanced.controls.pullBacksErrorMessage')"
						@retry="refetchNotices"
					>
						<template #loading>
							<div
								class="mt-3 h-16 animate-pulse rounded-lg bg-bg-surface"
								role="status"
								aria-live="polite"
								:aria-label="t('dashboard.admin.delivery.advanced.controls.pullBacksLoading')"
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
			:title="t('dashboard.admin.delivery.advanced.controls.forceDialog.title')"
			:phrase="FORCE_ADVANCE_CONFIRMATION"
			:confirm-label="t('dashboard.admin.delivery.advanced.controls.forceDialog.confirm')"
			@cancel="pendingForceShare = null"
			@confirm="confirmForceAdvance"
		>
			<template #consequence>
				<p data-testid="force-advance-consequence">
					{{
						t('dashboard.admin.delivery.advanced.controls.forceDialog.consequence', {
							cell:
								selectedCell === null
									? t('dashboard.admin.delivery.advanced.controls.forceDialog.theCell')
									: localized(rampCellLabel(selectedCell.cell)),
							share: pendingForceShare === null ? '' : shareLabel(pendingForceShare),
						})
					}}
				</p>
				<p>{{ t('dashboard.admin.delivery.advanced.controls.forceDialog.streakReset') }}</p>
			</template>
		</DeliveryRampConfirmDialog>
	</div>
</template>
