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
import { parseDeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { formatNumber, formatPercentage, formatShortDate } from '~/utils/formatters';
import {
	cellLabel,
	measurementHeadline,
	providerLabel,
	streamLabel,
} from '~/utils/deliverabilityMeasurement';
import { transportLabel } from '~/utils/transportState';

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

/**
 * THE RELAY IS NAMED, NOT KEYED. `referenceTransportId` is the stored transport
 * id, and "instead of ses" reads as a configuration value leaking onto the
 * screen people screenshot. `transportLabel` names the built-in kinds from the
 * same map the transport card and the DNS guidance use; a PLUGIN relay is named
 * from its id's leaf here and from the plugin catalog on the card, so those two
 * can still word one relay differently until this query carries the catalog
 * label.
 */
export function independenceSubhead(referenceTransportId: string | null): string {
	return referenceTransportId === null
		? 'How much your own server can send today, and what is holding that number back. There is no relay to move away from — this is the whole feature, not a reduced one.'
		: `How much of your mail your own server now carries instead of ${transportLabel(referenceTransportId)}.`;
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
 * `unmanaged` and `holding` are NEUTRAL, never warnings: a cell the ramp has not
 * taken over yet and a cell waiting for evidence are both perfectly healthy
 * states of a working deployment (plan D2/D10).
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
		facts.referenceTransportId === null ? 'the relay' : transportLabel(facts.referenceTransportId);
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
 * The type is read off the mutation so the four arms cannot drift from the
 * server's union, and the sentences are calm and end in something the operator
 * can actually do (plan D2): a refusal is the system explaining a rule, not the
 * UI reporting a failure.
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
		'This cell is not on the ramp yet. It starts being managed the first time the controller evaluates it.',
} as const satisfies Record<RampControlRefusal, string>;

export function rampRefusalSentence(refusal: RampControlRefusal): string {
	return REFUSAL_SENTENCES[refusal];
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
