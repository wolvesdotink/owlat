/**
 * THE RAMP, NARRATED — presentation only.
 *
 * Four operator-grade screens sit over the ramp controller, and none of them
 * answers the question the person on the deliverability page actually has: what
 * is happening to my sending right now, and is there anything for me to do. This
 * module turns the controls read into those three sentences — where the ramp is,
 * what the controller last decided, and the single most useful next move — so
 * the advanced screens become somewhere to go DEEPER rather than the only place
 * the ramp exists at all.
 *
 * EVERY FACT IS READ, NEVER RE-DERIVED. The decision sentences are the
 * controller's own, verbatim, for the same reason the cells screen renders them
 * that way: a second implementation of "why did the share move" could disagree
 * with the one that actually moved it. What this module adds is ORDER — which of
 * fifteen cells to speak about first — and nothing else.
 *
 * AND NOTHING UNCONFIGURED IS A WARNING (plan D2). A deployment with no cell on
 * the ramp is a deployment that has not made an optional choice yet; it gets an
 * invitation with a calm sentence, never a "setup incomplete".
 */

import {
	bindingConstraint,
	rampCellLabel,
	rampReasonLabel,
	shareLabel,
	type RampCellControl,
	type RampCellDecision,
	type RampControls,
} from '~/utils/deliverabilityRamp';
import type { LocalizedText } from '~/utils/deliverabilityMeasurement';

export type { LocalizedText };

/**
 * HOW A SENTENCE THAT NAMES A CELL GETS ITS NAME.
 *
 * Every value this module hands out is a catalog key — but two of its sentences
 * quote another catalog entry INSIDE themselves: the cell's name, and the
 * controller's own binding-constraint label. A key interpolated into a message
 * renders as the key, so those two take the caller's resolver, which is the same
 * `localized` the card already uses on everything else here.
 *
 * The default exists so a caller with nothing to translate with still gets a
 * value rather than a crash; it renders the key, which is a visible defect
 * rather than a silent mistranslation.
 */
export type NarrativeTranslator = (value: LocalizedText) => string;

const KEY_ONLY: NarrativeTranslator = (value) => (typeof value === 'string' ? value : value.key);

const CELLS_HREF = '/dashboard/admin/delivery/advanced/cells';
const CONTROLS_HREF = '/dashboard/admin/delivery/advanced/controls';
const MEASUREMENT_HREF = '/dashboard/admin/delivery/advanced/measurement';
const INDEPENDENCE_HREF = '/dashboard/admin/delivery/advanced/independence';

function managedCells(controls: RampControls): readonly RampCellControl[] {
	return controls.cells.filter((cell) => cell.isRampManaged);
}

/**
 * The cell to speak about when one has to be picked: the one carrying the most
 * of its own mail, and — among equals — the one with a decision behind it, so
 * the sentence beside it has something to say.
 */
function leadingCell(cells: readonly RampCellControl[]): RampCellControl | null {
	let leader: RampCellControl | null = null;
	for (const cell of cells) {
		if (leader === null || cell.ownShare > leader.ownShare) {
			leader = cell;
			continue;
		}
		if (cell.ownShare === leader.ownShare && leader.lastDecision === null) leader = cell;
	}
	return leader;
}

// ============ WHERE THE RAMP IS ============

export type RampNarrativePhaseKey = 'not_started' | 'paused' | 'warming' | 'graduated';

export interface RampNarrativeProgress {
	readonly graduated: number;
	readonly managed: number;
	/** 0–1, for the meter. The LABEL is what a screen reader is given. */
	readonly fraction: number;
	readonly label: LocalizedText;
}

export interface RampNarrativePhase {
	readonly key: RampNarrativePhaseKey;
	readonly title: LocalizedText;
	readonly detail: LocalizedText;
	/** Absent when there is nothing on the ramp to be a fraction of. */
	readonly progress: RampNarrativeProgress | null;
}

/**
 * WHAT THE RAMP IS DOING TO THIS DEPLOYMENT, in one heading and one sentence.
 *
 * The share sentence is cut on the cell's OWN `isShareRamped` and not on whether
 * a relay is configured, the same crossing the controls screen makes: a cell the
 * controller ramps by PACE already sends all of its mail from your own server,
 * and calling that "100% independent" would credit the ramp with a move it never
 * made — and would leave the operator waiting for a share to climb that is
 * already at its ceiling.
 */
export function rampPhaseNarrative(
	controls: RampControls,
	translate: NarrativeTranslator = KEY_ONLY
): RampNarrativePhase {
	const managed = managedCells(controls);
	if (managed.length === 0) {
		return {
			key: 'not_started',
			title: 'shared.deliverabilityRampNarrative.phase.notStarted.title',
			detail: 'shared.deliverabilityRampNarrative.phase.notStarted.detail',
			progress: null,
		};
	}

	const graduated = managed.filter((cell) => cell.graduatedAt !== null);
	const progress: RampNarrativeProgress = {
		graduated: graduated.length,
		managed: managed.length,
		fraction: graduated.length / managed.length,
		label: {
			key:
				managed.length === 1
					? 'shared.deliverabilityRampNarrative.progress.one'
					: 'shared.deliverabilityRampNarrative.progress.many',
			params: { graduated: graduated.length, managed: managed.length },
		},
	};

	if (controls.isControllerPaused) {
		return {
			key: 'paused',
			title: 'shared.deliverabilityRampNarrative.phase.paused.title',
			detail: 'shared.deliverabilityRampNarrative.phase.paused.detail',
			progress,
		};
	}

	if (graduated.length === managed.length) {
		return {
			key: 'graduated',
			title: 'shared.deliverabilityRampNarrative.phase.graduated.title',
			detail: controls.isRelayConfigured
				? 'shared.deliverabilityRampNarrative.phase.graduated.detailWithRelay'
				: 'shared.deliverabilityRampNarrative.phase.graduated.detail',
			progress,
		};
	}

	const leader = leadingCell(managed.filter((cell) => cell.graduatedAt === null));
	return {
		key: 'warming',
		title: 'shared.deliverabilityRampNarrative.phase.warming.title',
		detail:
			leader === null
				? 'shared.deliverabilityRampNarrative.phase.warming.noLeader'
				: warmingDetail(leader, translate),
		progress,
	};
}

/**
 * THE LEADER'S SENTENCE, ONE MESSAGE PER SHAPE.
 *
 * The ceiling clause and the streak sentence are part of the sentence rather
 * than fragments pasted onto it: a clause bolted on in code is a sentence no
 * translator can reorder, and the streak is the one number an operator watching
 * a share sit still is actually waiting on — a cell that has just retreated is at
 * zero, which is the honest answer rather than a silence.
 */
function warmingDetail(leader: RampCellControl, translate: NarrativeTranslator): LocalizedText {
	const streak =
		leader.cleanStreak <= 0 ? 'streakNone' : leader.cleanStreak === 1 ? 'streakOne' : 'streakMany';
	const name = translate(rampCellLabel(leader.cell));
	if (!leader.isShareRamped) {
		return {
			key: `shared.deliverabilityRampNarrative.phase.warming.unramped.${streak}`,
			params: { name, streak: leader.cleanStreak },
		};
	}
	const family = leader.phaseCeiling === null ? 'ramped' : 'rampedCeiling';
	return {
		key: `shared.deliverabilityRampNarrative.phase.warming.${family}.${streak}`,
		params: {
			name,
			share: shareLabel(leader.ownShare),
			ceiling: leader.phaseCeiling === null ? '' : shareLabel(leader.phaseCeiling),
			streak: leader.cleanStreak,
		},
	};
}

// ============ WHAT THE CONTROLLER DECIDED ============

export interface RampNarrativeDecision {
	readonly key: string;
	readonly at: number;
	readonly cellLabel: LocalizedText;
	readonly direction: RampCellDecision['direction'];
	/**
	 * The direction IN WORDS. A timeline that carried it as an arrow colour alone
	 * would say nothing at all to a screen reader, and "held" is the arm that
	 * matters most — it is the one an operator mistakes for the controller having
	 * stopped looking.
	 */
	readonly directionLabel: LocalizedText;
	readonly move: string;
	readonly reason: LocalizedText;
	/** The controller's sentence, verbatim. */
	readonly message: string;
	/** The retreat notice, verbatim, when the decision carried one. */
	readonly notice: string | null;
}

const DIRECTION_LABELS = {
	increase: 'shared.deliverabilityRampNarrative.direction.increase',
	decrease: 'shared.deliverabilityRampNarrative.direction.decrease',
	hold: 'shared.deliverabilityRampNarrative.direction.hold',
} as const satisfies Record<RampCellDecision['direction'], string>;

/**
 * THE LAST FEW THINGS THE CONTROLLER DID, ACROSS CELLS — newest first.
 *
 * One row per cell, because that is what the controls read carries: the newest
 * decision it made about each. A cell's full history, no-ops included, is the
 * cells screen's job, and this list links there rather than trying to be it.
 *
 * THE HOLDS ARE KEPT. A list of moves alone answers "what changed" and never
 * "was the controller even looking", which is the question behind a share that
 * has not budged in a week.
 */
export function recentRampDecisions(
	controls: RampControls,
	limit = 3
): readonly RampNarrativeDecision[] {
	const decided = controls.cells.flatMap((cell) =>
		cell.lastDecision === null ? [] : [{ cell, decision: cell.lastDecision }]
	);
	decided.sort((left, right) => right.decision.at - left.decision.at);
	return decided.slice(0, Math.max(0, limit)).map(({ cell, decision }) => ({
		key: cell.cellKey,
		at: decision.at,
		cellLabel: rampCellLabel(cell.cell),
		direction: decision.direction,
		directionLabel: DIRECTION_LABELS[decision.direction],
		move: `${shareLabel(decision.fromShare)} → ${shareLabel(decision.toShare)}`,
		reason: rampReasonLabel(decision.reason),
		message: decision.message,
		notice: decision.adminNotice,
	}));
}

// ============ THE ONE THING TO DO NEXT ============

export type RampNextActionKey =
	| 'resume_controller'
	| 'enroll_cell'
	| 'read_pull_back'
	| 'release_hold'
	| 'disconnect_relay'
	| 'watch_evidence';

export interface RampNextAction {
	readonly key: RampNextActionKey;
	readonly title: LocalizedText;
	readonly detail: LocalizedText;
	readonly ctaLabel: LocalizedText;
	readonly to: string;
}

/**
 * ONE ACTION, CHOSEN BY WHAT IT COSTS TO IGNORE.
 *
 * An empty ramp outranks even a pause: a controller with nothing to move is not
 * a thing to resume, and "Resume the ramp" beside a card that says no cell is on
 * it yet is two screens' worth of contradiction. A globally paused ramp outranks
 * everything after that, because nothing else on this card can happen while it
 * stands; a retreat outranks an operator's own hold because a gate broke and the
 * notice names what to do about it; a graduated deployment still paying a relay
 * outranks "keep watching" because that one is money.
 *
 * THE LAST ARM IS NOT A NAG. When the controller is simply working, the honest
 * next action is to look at the evidence it is working from — so the card always
 * ends in something worth clicking rather than an empty slot or an invented task.
 */
export function rampNextAction(
	controls: RampControls,
	translate: NarrativeTranslator = KEY_ONLY
): RampNextAction {
	const managed = managedCells(controls);

	if (managed.length === 0) {
		return {
			key: 'enroll_cell',
			title: 'shared.deliverabilityRampNarrative.action.enrollCell.title',
			detail: 'shared.deliverabilityRampNarrative.action.enrollCell.detail',
			ctaLabel: 'shared.deliverabilityRampNarrative.action.enrollCell.cta',
			to: CONTROLS_HREF,
		};
	}

	if (controls.isControllerPaused) {
		return {
			key: 'resume_controller',
			title: 'shared.deliverabilityRampNarrative.action.resumeController.title',
			detail: 'shared.deliverabilityRampNarrative.action.resumeController.detail',
			ctaLabel: 'shared.deliverabilityRampNarrative.action.resumeController.cta',
			to: CONTROLS_HREF,
		};
	}

	const retreating = leadingRetreat(managed);
	if (retreating !== null) {
		return {
			key: 'read_pull_back',
			title: {
				key: 'shared.deliverabilityRampNarrative.action.readPullBack.title',
				params: { cell: translate(rampCellLabel(retreating.cell.cell)) },
			},
			// The controller's own notice where it wrote one, its decision sentence
			// otherwise. Both name the gate that broke; neither is re-worded here —
			// and neither is translated here either: they are the server's words.
			detail: retreating.decision.adminNotice ?? retreating.decision.message,
			ctaLabel: 'shared.deliverabilityRampNarrative.action.readPullBack.cta',
			to: CELLS_HREF,
		};
	}

	const held = managed.find((cell) => cell.isPaused || cell.pinnedShare !== null);
	if (held !== undefined) {
		return {
			key: 'release_hold',
			title: {
				key: 'shared.deliverabilityRampNarrative.action.releaseHold.title',
				params: { cell: translate(rampCellLabel(held.cell)) },
			},
			detail: held.isPaused
				? 'shared.deliverabilityRampNarrative.action.releaseHold.detailPaused'
				: {
						key: 'shared.deliverabilityRampNarrative.action.releaseHold.detailPinned',
						params: { share: shareLabel(held.pinnedShare ?? 0) },
					},
			ctaLabel: 'shared.deliverabilityRampNarrative.action.releaseHold.cta',
			to: CONTROLS_HREF,
		};
	}

	if (managed.every((cell) => cell.graduatedAt !== null) && controls.isRelayConfigured) {
		return {
			key: 'disconnect_relay',
			title: 'shared.deliverabilityRampNarrative.action.disconnectRelay.title',
			detail: 'shared.deliverabilityRampNarrative.action.disconnectRelay.detail',
			ctaLabel: 'shared.deliverabilityRampNarrative.action.disconnectRelay.cta',
			to: INDEPENDENCE_HREF,
		};
	}

	const leader = leadingCell(managed.filter((cell) => cell.graduatedAt === null));
	return {
		key: 'watch_evidence',
		title: 'shared.deliverabilityRampNarrative.action.watchEvidence.title',
		detail:
			leader === null
				? 'shared.deliverabilityRampNarrative.action.watchEvidence.detail'
				: {
						key: 'shared.deliverabilityRampNarrative.action.watchEvidence.detailLeader',
						params: {
							cell: translate(rampCellLabel(leader.cell)),
							// The constraint is the controller's own label; the trailing stop
							// is trimmed rather than assumed, because some of those labels
							// carry one ("Waiting for the first evaluation.") and most do not.
							constraint: translate(bindingConstraint(leader)).replace(/\.$/, ''),
						},
					},
		ctaLabel: 'shared.deliverabilityRampNarrative.action.watchEvidence.cta',
		to: MEASUREMENT_HREF,
	};
}

/**
 * The most recently retreated cell that is still sitting in that retreat, WITH
 * the decision that put it there — the two travel together because the caller
 * needs both, and returning the cell alone would leave it re-reading a
 * `lastDecision` this search has already proved is a retreat.
 */
function leadingRetreat(
	cells: readonly RampCellControl[]
): { cell: RampCellControl; decision: RampCellDecision } | null {
	let worst: { cell: RampCellControl; decision: RampCellDecision } | null = null;
	for (const cell of cells) {
		const decision = cell.lastDecision;
		if (decision === null || decision.direction !== 'decrease') continue;
		if (worst === null || decision.at > worst.decision.at) worst = { cell, decision };
	}
	return worst;
}

// ============ PROGRESSIVE DISCLOSURE ============

export interface RampAdvancedScreen {
	readonly to: string;
	readonly label: LocalizedText;
	readonly description: LocalizedText;
	readonly icon: string;
}

/**
 * THE FOUR SCREENS BEHIND THIS CARD, each described by what it ANSWERS.
 *
 * The independence entry follows the D14 rename: with no relay connected there
 * is nothing to become independent OF, and that screen calls itself "Warm-up
 * autopilot" — a link that promised "Independence" would land the operator on a
 * heading they never asked for.
 */
export function rampAdvancedScreens(isRelayConfigured: boolean): readonly RampAdvancedScreen[] {
	return [
		{
			to: CELLS_HREF,
			label: 'shared.deliverabilityRampNarrative.screens.cells.label',
			description: 'shared.deliverabilityRampNarrative.screens.cells.description',
			icon: 'lucide:grid-3x3',
		},
		{
			to: CONTROLS_HREF,
			label: 'shared.deliverabilityRampNarrative.screens.controls.label',
			description: 'shared.deliverabilityRampNarrative.screens.controls.description',
			icon: 'lucide:sliders-horizontal',
		},
		{
			to: MEASUREMENT_HREF,
			label: 'shared.deliverabilityRampNarrative.screens.measurement.label',
			description: 'shared.deliverabilityRampNarrative.screens.measurement.description',
			icon: 'lucide:activity',
		},
		isRelayConfigured
			? {
					to: INDEPENDENCE_HREF,
					label: 'shared.deliverabilityRampNarrative.screens.independence.label',
					description: 'shared.deliverabilityRampNarrative.screens.independence.description',
					icon: 'lucide:trending-up',
				}
			: {
					to: INDEPENDENCE_HREF,
					label: 'shared.deliverabilityRampNarrative.screens.warmupAutopilot.label',
					description: 'shared.deliverabilityRampNarrative.screens.warmupAutopilot.description',
					icon: 'lucide:trending-up',
				},
	];
}
