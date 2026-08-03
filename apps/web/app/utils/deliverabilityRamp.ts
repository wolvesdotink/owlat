/**
 * THE RAMP SCREENS' VOCABULARY — presentation only (plan D2, D12, D14, P3-6).
 *
 * DELIVERABILITY FEATURES FAIL WHEN THEY FEEL LIKE MAGIC, so the job of this
 * module is to make a controller decision READ like a decision: what the cell is
 * doing, what is holding it back, and who or what decided that. Every one of
 * those facts is READ, never re-derived — the server recorded the binding
 * constraint and its sentence when the decision was made, and a second
 * implementation here could disagree with the one that actually moved the share.
 *
 * NOTHING THAT IS MERELY UNMEASURED OR UNCONFIGURED IS EVER RENDERED IN A
 * WARNING TONE (plan D2). A cell nobody has sent through, a deployment with no
 * relay, a projection with too little history: each gets a calm sentence and, in
 * every case, a concrete thing the operator could do if they want to — an
 * invitation, never a nag and never a "setup incomplete".
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import {
	INDEPENDENCE_PROJECTION_MIN_DAYS,
	type IndependenceProjection,
	type RampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import { formatNumber, formatPercentage, formatShortDate } from '~/utils/formatters';
import {
	cellLabel,
	measurementHeadline,
	providerLabel,
	streamLabel,
} from '~/utils/deliverabilityMeasurement';

export type RampControls = FunctionReturnType<
	typeof api.delivery.rampControlQueries.getRampControls
>;
export type RampCellControl = RampControls['cells'][number];
export type RampCellDecision = NonNullable<RampCellControl['lastDecision']>;
/**
 * The controller's closed reason union, taken off the QUERY rather than imported
 * across the package boundary: the query is where it is already narrowed, and
 * reaching into `apps/api`'s internals from a page module is the coupling the
 * cross-package import check exists to prevent.
 */
export type RampDecisionReason = RampCellDecision['reason'];
export type IndependenceSummary = FunctionReturnType<
	typeof api.delivery.rampIndependence.getIndependenceSummary
>;
export type RampAdminNotice = FunctionReturnType<
	typeof api.delivery.rampControlQueries.listRampAdminNotices
>[number];

// ============ THE HEADLINE (D14) ============

/**
 * WITH NO RELAY THERE IS NOTHING TO BECOME INDEPENDENT OF, so the screen is not
 * a degraded "Sending independence" — it is a different, honest feature whose
 * headline is today's capacity and what is holding it back (plan D14).
 *
 * ONE FUNCTION, TWO SCREENS. The Measurement dashboard shipped this exact rename
 * first; re-deciding it here would let the two screens disagree about what the
 * standalone feature is CALLED, which is the one thing D14 cares about. So this
 * is an alias, not a copy — the SUBHEAD below is genuinely different prose (that
 * screen is read-only; this one is the ramp) and stays local.
 */
export const independenceHeadline = measurementHeadline;

export function independenceSubhead(referenceTransportId: string | null): string {
	return referenceTransportId === null
		? 'How much your own server can send today, and what is holding that number back. There is no relay to move away from — this is the whole feature, not a reduced one.'
		: `How much of your mail your own server now carries instead of ${referenceTransportId}.`;
}

/** The month-to-date own-arm volume sentence — always available, always true. */
export function volumeSentence(summary: IndependenceSummary): string {
	return `${formatNumber(summary.monthToDateOwnSends)} messages sent from your own server this month.`;
}

/**
 * Format a minor-unit amount in its own currency.
 *
 * The exponent comes from `Intl.NumberFormat`, which knows that JPY has none and
 * that KWD has three. An unknown or malformed code makes `Intl` throw; that must
 * never take a screen down over a settings typo, so the fallback prints the code
 * beside the raw amount and remains readable.
 */
function formatCurrencyFromMinorUnits(minorUnits: number, currency: string): string {
	try {
		const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
		return format.format(minorUnits / 10 ** digits);
	} catch {
		return `${currency} ${formatNumber(minorUnits)} (minor units)`;
	}
}

/**
 * THE MONEY, OR AN HONEST ABSENCE. A relay price the product invented would be
 * quoted back at us as fact, so when nobody has recorded one the screen says
 * what it would take to show the figure rather than printing a confident guess.
 */
export function spendAvoidedCopy(summary: IndependenceSummary): string {
	if (summary.spendAvoidedMinorUnits === null || summary.spendAvoidedCurrency === null) {
		return 'Add what your relay charges per thousand messages to see the spend this replaces.';
	}
	// MINOR UNITS ARE NOT ALWAYS HUNDREDTHS. JPY has no minor unit at all and
	// KWD/BHD have three digits, so the exponent is read off the CURRENCY through
	// `Intl` rather than assumed to be 100 — a hardcoded divisor would misstate a
	// yen figure by two orders of magnitude on the screen people screenshot.
	const currency = summary.spendAvoidedCurrency;
	const minor = summary.spendAvoidedMinorUnits;
	return `${formatCurrencyFromMinorUnits(minor, currency)} of relay spend avoided this month.`;
}

/**
 * The projected date the relay stops carrying mail — one sentence per arm of the
 * closed union, because the four non-answers mean genuinely different things and
 * a single "unknown" would tell a standalone deployment nothing at all.
 */
export function projectionCopy(projection: IndependenceProjection): string {
	switch (projection.kind) {
		case 'projected':
			return `On the current pace you stop paying a relay around ${formatShortDate(projection.at)} — about ${projection.dailyGainPp.toFixed(2)} points of share gained per day.`;
		case 'already_independent':
			return 'Your own server already carries this traffic. There is no relay bill left to end.';
		case 'not_advancing':
			return 'The share is not climbing at the moment, so there is no honest date to give. It will appear once the ramp starts advancing again.';
		case 'beyond_horizon':
			return 'At the current pace the finish line is more than two years out, which is too far to quote. A faster preset or more volume would bring it closer.';
		case 'insufficient_data':
			return `Not enough history yet — ${formatNumber(projection.usableDays)} of ${formatNumber(INDEPENDENCE_PROJECTION_MIN_DAYS)} days with traffic. Keep sending and the date will appear.`;
	}
}

/** The standalone headline: what the deployment can send today. */
export function capacityCopy(summary: IndependenceSummary): string {
	const remaining = summary.capacity.remainingToday;
	if (remaining === null) {
		return 'No warming ceiling is being reported right now, so there is no daily number to show. Your sending is unaffected.';
	}
	return `${formatNumber(remaining)} more messages can go out from your own server today.`;
}

// ============ CELL STATE ============

export type RampCellTone = 'ok' | 'attention' | 'neutral';

export interface RampCellStatus {
	readonly key: string;
	readonly label: string;
	readonly tone: RampCellTone;
}

/**
 * ONE STATUS PER CELL, decided in ONE table so the word and the colour cannot
 * be chosen in two places and disagree.
 *
 * `unmanaged` and `holding` are NEUTRAL, never warnings: a cell nobody has put
 * on the ramp and a cell waiting for evidence are both perfectly healthy states
 * of a working deployment (plan D2/D10). Enrolment is an OPT-IN, so `unmanaged`
 * is a choice not yet made rather than a step not yet finished.
 */
export function rampCellStatus(cell: RampCellControl): RampCellStatus {
	if (!cell.isRampManaged) {
		return { key: 'unmanaged', label: 'Not on the ramp yet', tone: 'neutral' };
	}
	if (cell.graduatedAt !== null) return { key: 'graduated', label: 'Graduated', tone: 'ok' };
	if (cell.isPaused) return { key: 'paused', label: 'Paused by you', tone: 'neutral' };
	if (cell.pinnedShare !== null) {
		return {
			key: 'pinned',
			label: `Pinned at ${formatPercentage(cell.pinnedShare, 0)}`,
			tone: 'neutral',
		};
	}
	if (cell.lastDecision?.direction === 'decrease') {
		return { key: 'retreating', label: 'Pulled back', tone: 'attention' };
	}
	if (cell.lastDecision?.direction === 'increase') {
		return { key: 'advancing', label: 'Advancing', tone: 'ok' };
	}
	return { key: 'holding', label: 'Holding', tone: 'neutral' };
}

/**
 * WHAT IS HOLDING THIS CELL BACK — read off the last decision, never recomputed.
 * A cell with no decisions yet says so plainly instead of inventing a constraint.
 */
export function bindingConstraint(cell: RampCellControl): string {
	if (cell.lastDecision === null) {
		return cell.isRampManaged
			? 'Waiting for the first evaluation.'
			: 'Nothing — this cell is not being ramped yet.';
	}
	return rampReasonLabel(cell.lastDecision.reason);
}

/**
 * EXHAUSTIVE BY CONSTRUCTION. `satisfies` against the stored union means a rung
 * added to the controller next month fails this build instead of quietly
 * rendering its snake_case code in the Cells grid's "Holding it back" column.
 */
const REASON_LABELS = {
	kill_switch: 'The global ramp pause',
	clock_unusable: 'An unusable clock',
	abuse_status: 'The account’s abuse status',
	breaker: 'The MTA circuit breaker',
	dnsbl: 'A critical blocklist listing',
	frozen: 'A cooldown from an earlier retreat',
	freeze_unreadable: 'An unreadable stored cooldown',
	share_unreadable: 'An unreadable stored share',
	holding: 'Not enough fresh evidence',
	evidence_stale: 'Evidence too old to act on',
	awaiting_corroboration: 'A seed tripwire waiting for corroboration',
	capacity_unknown: 'An unusable capacity projection',
	window_open: 'This window has already been counted',
	building_confidence: 'Building a clean streak',
	capacity_ceiling: 'Remaining warming capacity',
	phase_ceiling: 'The phase ceiling',
	// P3-8's cap: the substitution table lowers the phase ceiling a rung while an
	// integration is missing, which is a DIFFERENT fact from having reached the
	// ceiling this cell was granted — the operator can act on one and not the other.
	degradation_ceiling: 'A ceiling lowered by a missing integration',
	healthy: 'Nothing — every gate is green',
	graduated: 'Nothing — the cell is graduated and pinned',
	operator_pause: 'Your pause on this cell',
	operator_pin: 'Your pin on this cell',
	operator_force_advance: 'A manual advance you made',
	operator_phase_reset: 'A manual phase reset you made',
	operator_enrollment: 'Putting this cell on the ramp',
	operator_phase_promotion: 'A phase promotion you made',
	hard_bounce: 'The hard-bounce gate',
	deferral: 'The deferral gate',
	complaint: 'The complaint gate',
	engagement_ratio: 'The engagement gate',
	seed_placement: 'The seed-placement tripwire',
} satisfies Record<RampDecisionReason, string>;

/**
 * The map above is exhaustive over the CURRENT union, so a live reason always
 * has a label. The fallback is for LEGACY STORED ROWS only: `mixDecisions` keeps
 * ninety days of history, so a reason retired in that window is still readable
 * on the timeline and renders as its code rather than as nothing at all.
 */
export function rampReasonLabel(reason: RampDecisionReason | string): string {
	const label = (REASON_LABELS as Record<string, string | undefined>)[reason];
	return label ?? reason.replace(/_/g, ' ');
}

export function shareLabel(share: number): string {
	return formatPercentage(share, 0);
}

// ============ REFUSALS ============

/**
 * A control the server DECLINED to apply — `{applied: false, refusal}` rather
 * than a thrown error, because none of these is a fault.
 *
 * The type is read off the mutation so the arms cannot drift from the server's
 * union — which is ONE union across every ramp write, enrolment and promotion
 * included — and the sentences are calm and end in something the operator can
 * actually do (plan D2): a refusal is the system explaining a rule, not the UI
 * reporting a failure.
 */
export type RampControlRefusal = NonNullable<
	FunctionReturnType<typeof api.delivery.rampControls.setCellPause>['refusal']
>;

const REFUSAL_SENTENCES = {
	controller_paused:
		'The ramp is globally paused, so this cell cannot be raised right now. Resume the ramp first.',
	hard_stop_active:
		'A safety hold is active on this cell — an abuse hold, an open circuit breaker, a critical blocklist listing or a cooldown from an earlier pull-back. Clear it and try again.',
	cell_not_ramp_managed:
		'This cell is not on the ramp yet. Put it on the ramp to let the controller decide its share.',
	cell_already_ramp_managed:
		'This cell is already on the ramp, so it keeps the streak and the phase it has earned. Use the phase reset to start it over.',
	phase_increase_requires_promotion:
		'A phase ceiling only ever rises through a promotion, which checks the evidence for the next rung. Promote the cell instead of resetting it upward.',
	promotion_evidence_outstanding:
		'The evidence for the next phase is not in yet. The conditions still outstanding are listed with the cell, and the promotion works as soon as any one route is complete.',
} as const satisfies Record<RampControlRefusal, string>;

export function rampRefusalSentence(refusal: RampControlRefusal): string {
	return REFUSAL_SENTENCES[refusal];
}

// ============ PROMOTION EVIDENCE (D3) ============

/**
 * A condition the next phase rung is still waiting on.
 *
 * Read off the mutation for the same reason the refusals are: the server decides
 * which routes apply to a cell and which of their conditions are unmet, and a
 * label map that could go quiet on a condition would leave an operator reading
 * "not yet" with nothing to act on.
 */
export type RampPromotionCondition = NonNullable<
	FunctionReturnType<typeof api.delivery.rampPhasePromotion.promoteCellPhase>['outstanding']
>[number];

/** Each condition as the THING TO DO, not as the identifier it is stored under. */
const PROMOTION_CONDITION_LABELS = {
	google_compliance_pass: 'Google’s Compliance Status passing for this domain in the last 7 days',
	snds_complaint_band_green: 'Microsoft SNDS reporting a green complaint band in the last 7 days',
	dwell_multiple_served: 'longer spent at the current phase',
	seed_probe_pass_recent: 'a recent passing seed-mailbox placement probe',
	dnsbl_clean_streak: '14 consecutive blocklist-clean days across every sending IP',
	deferral_under_threshold_all_cells: 'every cell’s deferral rate under its threshold',
} as const satisfies Record<RampPromotionCondition, string>;

/**
 * NARROW, AND NO FALLBACK. The map is exhaustive over the union by construction
 * and the union is read off the mutation, so a widened parameter would only buy
 * an unreachable branch — one that renders a snake_case identifier, which is the
 * "goes quiet on a condition" behaviour the map above exists to prevent. A
 * condition added server-side has to fail the BUILD here rather than degrade at
 * runtime. (`rampReasonLabel` keeps its fallback for the opposite reason: it
 * reads ninety days of stored history, where a retired code genuinely arrives.)
 */
export function rampPromotionConditionLabel(condition: RampPromotionCondition): string {
	return PROMOTION_CONDITION_LABELS[condition];
}

// ============ WHAT A WRITE ACTUALLY DID ============

/**
 * Which setup path enrolment resolved the cell onto (plan D14), read off the
 * mutation like every other vocabulary here. The fork is decided SERVER-SIDE and
 * never chosen by the operator, so the sentence below is the only place they
 * learn which of the two ramps they got.
 */
export type RampEnrollmentPath = NonNullable<
	FunctionReturnType<typeof api.delivery.rampEnrollment.enrollCell>['path']
>;

/**
 * WHAT PUTTING THE CELL ON THE RAMP ACTUALLY DID.
 *
 * Without it the only visible effect of an enrolment is the controls going live
 * — and the outcomes are genuinely different ramps: a measured sliver of the
 * cell against the relay, or the whole cell on the own server with the warm-up
 * pace as the dial that moves. An operator who cannot tell which one they got
 * cannot read anything else on this screen either.
 *
 * AND THE SHARE ONLY MOVES MAIL WHERE THE STREAM'S ROUTE SPLITS BY IT. The
 * server answers that (`isShareRouted`) rather than the screen guessing from the
 * path: a cell can be on the ESP path — a relay is configured — while the
 * stream's route is a shipped `priority_failover` that sends every message the
 * same way it did yesterday. Saying "your relay carries the rest" there would
 * describe traffic that never moved, and the number beside it would look broken
 * rather than dormant.
 */
export function rampEnrolledSentence(
	share: number,
	path: RampEnrollmentPath,
	isShareRouted: boolean
): string {
	if (path !== 'esp_relay') {
		return `On the ramp at ${shareLabel(share)} of this cell. There is no relay to move traffic away from, so the whole cell sends from your own server and the warm-up pace is the dial that ramps.`;
	}
	return isShareRouted
		? `On the ramp at ${shareLabel(share)} of this cell — your relay carries the rest, and the controller moves the share only on the evidence.`
		: `On the ramp at ${shareLabel(share)} of this cell, and the controller moves it only on the evidence. No mail follows that share yet: this stream's route does not split by share, so every message keeps going where the route already sends it.`;
}

/**
 * THE PROMOTION'S TWO NON-REFUSAL ANSWERS. "Not yet" has its own refusal
 * sentence and its own list of conditions; these are the other two — the rung
 * moved, or the cell was already on the top one. The second is why the button is
 * disabled up there, and the sentence covers the case where the screen's copy of
 * the rung is behind the row's.
 */
export function rampPromotionSentence(applied: boolean, phaseCeiling: number): string {
	return applied
		? `Promoted to the ${shareLabel(phaseCeiling)} phase. The share does not jump — it climbs toward the new ceiling on the ordinary checks.`
		: `This cell is already on the top phase rung (${shareLabel(phaseCeiling)}), so there is nothing left to promote.`;
}

// ============ PRESETS ============

export interface RampPresetOption {
	readonly value: RampPreset;
	readonly label: string;
	readonly description: string;
}

/**
 * The three presets, described in terms of the TRADE-OFF rather than in praise.
 * None is labelled "recommended": the honest statement is what each costs and
 * buys, and the deployment default is shown separately (plan D14).
 */
export const RAMP_PRESET_OPTIONS: readonly RampPresetOption[] = [
	{
		value: 'conservative',
		label: 'Conservative',
		description:
			'Half-size steps and two extra clean windows before each one. Slowest to finish, least likely to overshoot a provider’s tolerance.',
	},
	{
		value: 'balanced',
		label: 'Balanced',
		description: 'The shipped pace: full-size steps after three consecutive clean windows.',
	},
	{
		value: 'aggressive',
		label: 'Aggressive',
		description:
			'Half again the step size on the same evidence. Reaches full share sooner and retreats from further up when a gate breaks.',
	},
];

/**
 * THE CELL VOCABULARY IS THE MEASUREMENT SCREEN'S, IMPORTED. Re-declaring the
 * stream and provider maps here gave two screens two chances to name the same
 * axis differently, and the copies were `Record<string, string>` with `??`
 * fallbacks — so a provider added to `DESTINATION_PROVIDER_KEYS` would have
 * rendered as a raw key on this screen and as a compile error on that one. The
 * exhaustive originals are the ones worth keeping.
 */
export { cellLabel as rampCellLabel, providerLabel, streamLabel };
