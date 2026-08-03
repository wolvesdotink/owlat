/**
 * THE RAMP SCREENS' PER-CELL VOCABULARY — presentation only (plan D2, D12, P3-6).
 *
 * The deployment-level half — the independence headline, the money, the
 * projection — lives in `deliverabilityIndependenceCopy.ts` (plan D14). The cut
 * follows the screens: this module speaks about a cell, that one about the
 * install.
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
import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';
import { parseDeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { formatNumber, formatPercentage, formatShortDate } from '~/utils/formatters';
import { cellLabel, providerLabel, streamLabel } from '~/utils/deliverabilityMeasurement';
import { transportIdLabel } from '~/utils/transportState';

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
export type RampAdminNotice = FunctionReturnType<
	typeof api.delivery.rampControlQueries.listRampAdminNotices
>[number];

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

// ============ DISCONNECTING THE RELAY ============

/** The consequence of pulling the relay, in words. Facts in, sentences out. */
export interface RelayRemovalConsequence {
	/** What disconnecting does right now, in this deployment's own numbers. */
	readonly consequence: string;
	/** The date waiting would make it free, or null when nothing projects one. */
	readonly safeDate: string | null;
}

export interface RelayRemovalFacts {
	/**
	 * The cells still leaning on the relay. THE EMPTY LIST AND `null` ARE
	 * DIFFERENT FACTS and the caller may not collapse them: `[]` is a read that
	 * answered and found every cell graduated, `null` is a read that did not
	 * answer at all. Passing an empty list for the second one puts a "cannot be
	 * treated as safe" sentence on a deployment that has nothing left to lose.
	 */
	readonly dependentCells: readonly string[] | null;
	/** The second arm's transport id, or null when it could not be read. */
	readonly referenceTransportId: string | null;
	readonly projectedSafeAt: number | null;
}

/**
 * THE RELAY-REMOVAL CONSEQUENCE — ONE SENTENCE, THREE SURFACES.
 *
 * The Independence screen, the transport editor and `POST
 * /api/delivery/apply-transport` all have to name the same consequence for the
 * same click: the screen that ASKS, the dialog that confirms, and the endpoint
 * that REFUSES. Three hand-written copies is three chances for them to quote
 * different stakes, and the operator meets at least two of them in one attempt.
 * The FACTS are the server's (`relayRemoval` off `getIndependenceSummary`); only
 * the words are here.
 *
 * A COUNT WE DO NOT HAVE IS NOT ZERO, AND ZERO IS NOT A COUNT WE DO NOT HAVE.
 * Three states, three sentences: `null` is a read that never answered (the
 * browser's faulted, or the server's did and it refused fail-closed) and may not
 * print "0 cells have not graduated yet"; an EMPTY list is a read that answered
 * and found every cell graduated, and may not print "could not be established"
 * over a deployment the same screen has just called safe.
 */
export function relayRemovalConsequenceCopy(facts: RelayRemovalFacts): RelayRemovalConsequence {
	const relay =
		facts.referenceTransportId === null
			? 'the relay'
			: transportIdLabel(facts.referenceTransportId);
	const lostFallback = `the reputation ${relay} has built for your domain stops being available to fall back on`;
	// The tail every arm that MOVES traffic shares; the safe arm ends differently
	// because nothing moves and only the fallback is given up.
	const moved = ` onto your own server immediately — not gradually — and ${lostFallback}.`;
	const cells = facts.dependentCells;
	const count = cells?.length ?? 0;
	const consequence =
		cells === null
			? `Which cells are still leaning on ${relay} could not be established, so this cannot be treated as safe. Disconnecting it moves whatever they still send${moved}`
			: count === 0
				? `Every cell has graduated, so nothing is still leaning on ${relay}. Disconnecting it now would not move any traffic onto your own server — only ${lostFallback}.`
				: count === 1
					? `1 cell has not graduated yet and still sends part of its mail through ${relay}. Disconnecting it moves all of that traffic${moved}`
					: `${formatNumber(count)} cells have not graduated yet and still send part of their mail through ${relay}. Disconnecting it moves all of that traffic${moved}`;
	return {
		consequence,
		safeDate:
			facts.projectedSafeAt === null
				? null
				: `On the current pace, waiting until about ${formatShortDate(facts.projectedSafeAt)} would avoid that entirely.`,
	};
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
 *
 * AND WHAT THE NEW RUNG DOES DEPENDS ON WHETHER THERE IS A SECOND SENDER
 * (`isRelayConfigured`, the same fact the reset copy reads). The phase ladder
 * bounds the SHARE dial, so on a standalone cell `phaseLadderBounds` drops the
 * ceiling entirely: nothing climbs toward it, and a promoted pace-path cell
 * already sends the whole cell from its own server. "It climbs toward the new
 * ceiling" there names a movement that cannot happen.
 */
export function rampPromotionSentence(
	applied: boolean,
	phaseCeiling: number,
	isRelayConfigured: boolean
): string {
	if (!applied) {
		return `This cell is already on the top phase rung (${shareLabel(phaseCeiling)}), so there is nothing left to promote.`;
	}
	return isRelayConfigured
		? `Promoted to the ${shareLabel(phaseCeiling)} phase. The share does not jump — it climbs toward the new ceiling on the ordinary checks.`
		: `Promoted to the ${shareLabel(phaseCeiling)} phase. The share does not jump, and with no relay connected there is nothing holding it below the rung: the rung is recorded, and it bounds the share the day a second sender carries this cell again.`;
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

/**
 * THE SAME CELL, NAMED THE SAME WAY, from a stored KEY rather than a pair.
 *
 * The retreat notices carry `campaign:gmail` because that is what the decision
 * row stores, while every other surface names that cell "Campaign → Gmail". An
 * unparseable key — a stream retired since the row was written — reads as
 * itself, because a ninety-day history has to stay readable.
 */
export function rampCellKeyLabel(cellKey: string): string {
	const cell = parseDeliverabilityCellKey(cellKey);
	return cell === null ? cellKey : cellLabel(cell);
}
