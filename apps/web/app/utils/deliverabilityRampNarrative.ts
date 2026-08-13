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

const CELLS_HREF = '/dashboard/admin/delivery/advanced/cells';
const CONTROLS_HREF = '/dashboard/admin/delivery/advanced/controls';
const MEASUREMENT_HREF = '/dashboard/admin/delivery/advanced/measurement';
const INDEPENDENCE_HREF = '/dashboard/admin/delivery/advanced/independence';

function cellCount(count: number): string {
	return count === 1 ? '1 cell' : `${count} cells`;
}

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
	readonly label: string;
}

export interface RampNarrativePhase {
	readonly key: RampNarrativePhaseKey;
	readonly title: string;
	readonly detail: string;
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
export function rampPhaseNarrative(controls: RampControls): RampNarrativePhase {
	const managed = managedCells(controls);
	if (managed.length === 0) {
		return {
			key: 'not_started',
			title: 'No cell is on the ramp yet',
			detail:
				'Nothing is wrong: putting a cell on the ramp is a choice, and until you make it your mail keeps going out exactly the way it does today. Once a cell is on it, the controller moves that cell’s share only when the checks agree.',
			progress: null,
		};
	}

	const graduated = managed.filter((cell) => cell.graduatedAt !== null);
	const progress: RampNarrativeProgress = {
		graduated: graduated.length,
		managed: managed.length,
		fraction: graduated.length / managed.length,
		label: `${graduated.length} of ${cellCount(managed.length)} on the ramp graduated so far`,
	};

	if (controls.isControllerPaused) {
		return {
			key: 'paused',
			title: 'The ramp is paused',
			detail:
				'Every cell is pinned where it is, and nothing will move until you resume it. The checks keep running while it is held, so you can see what would have happened.',
			progress,
		};
	}

	if (graduated.length === managed.length) {
		return {
			key: 'graduated',
			title: 'Every cell on the ramp has graduated',
			detail: controls.isRelayConfigured
				? 'Each of them carries its full share from your own server, and the controller is holding them there. The relay is still connected and still being paid for.'
				: 'Each of them carries its full share from your own server, and the controller is holding them there.',
			progress,
		};
	}

	const leader = leadingCell(managed.filter((cell) => cell.graduatedAt === null));
	return {
		key: 'warming',
		title: 'Warming up',
		detail: leader === null ? warmingWithoutLeader() : warmingDetail(leader),
		progress,
	};
}

function warmingWithoutLeader(): string {
	return 'The controller is moving each cell’s share on the evidence, one clean window at a time.';
}

function warmingDetail(leader: RampCellControl): string {
	const name = rampCellLabel(leader.cell);
	if (!leader.isShareRamped) {
		return `${name} is the one to watch: with no second sender on it, the whole cell already leaves from your own server and the warm-up pace — not the share — is the dial the controller moves. ${streakSentence(leader)}`;
	}
	const ceiling =
		leader.phaseCeiling === null
			? ''
			: `, against a ${shareLabel(leader.phaseCeiling)} ceiling on its current phase`;
	return `${name} is the furthest along: ${shareLabel(leader.ownShare)} of that mail leaves from your own server${ceiling}. ${streakSentence(leader)}`;
}

/**
 * HOW CLOSE THE NEXT STEP IS, in the controller's own currency. The clean streak
 * is the thing an operator watching a share sit still is actually waiting on,
 * and a cell that has just retreated is at zero — which is the honest answer
 * rather than a silence.
 */
function streakSentence(cell: RampCellControl): string {
	if (cell.cleanStreak <= 0) {
		return 'It has no clean streak yet — the count restarts at zero after every retreat and after every manual move.';
	}
	const windows = cell.cleanStreak === 1 ? '1 clean window' : `${cell.cleanStreak} clean windows`;
	return `${windows} in a row so far.`;
}

// ============ WHAT THE CONTROLLER DECIDED ============

export interface RampNarrativeDecision {
	readonly key: string;
	readonly at: number;
	readonly cellLabel: string;
	readonly direction: RampCellDecision['direction'];
	/**
	 * The direction IN WORDS. A timeline that carried it as an arrow colour alone
	 * would say nothing at all to a screen reader, and "held" is the arm that
	 * matters most — it is the one an operator mistakes for the controller having
	 * stopped looking.
	 */
	readonly directionLabel: string;
	readonly move: string;
	readonly reason: string;
	/** The controller's sentence, verbatim. */
	readonly message: string;
	/** The retreat notice, verbatim, when the decision carried one. */
	readonly notice: string | null;
}

const DIRECTION_LABELS = {
	increase: 'Raised',
	decrease: 'Pulled back',
	hold: 'Held',
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
	readonly title: string;
	readonly detail: string;
	readonly ctaLabel: string;
	readonly to: string;
}

/**
 * ONE ACTION, CHOSEN BY WHAT IT COSTS TO IGNORE.
 *
 * A globally paused ramp outranks everything because nothing else on this card
 * can happen while it stands; a retreat outranks an operator's own hold because
 * a gate broke and the notice names what to do about it; a graduated deployment
 * still paying a relay outranks "keep watching" because that one is money.
 *
 * THE LAST ARM IS NOT A NAG. When the controller is simply working, the honest
 * next action is to look at the evidence it is working from — so the card always
 * ends in something worth clicking rather than an empty slot or an invented task.
 */
export function rampNextAction(controls: RampControls): RampNextAction {
	const managed = managedCells(controls);

	if (controls.isControllerPaused) {
		return {
			key: 'resume_controller',
			title: 'Resume the ramp',
			detail:
				'The whole ramp is paused, so no share will move — up or down — however good or bad the evidence gets. Resume it when you are ready for the controller to act again.',
			ctaLabel: 'Open the ramp controls',
			to: CONTROLS_HREF,
		};
	}

	if (managed.length === 0) {
		return {
			key: 'enroll_cell',
			title: 'Put your first cell on the ramp',
			detail:
				'Pick one stream and one mailbox provider — campaign mail to Gmail is the usual first choice — and the controller starts moving that slice on the evidence alone. Nothing else about your sending changes.',
			ctaLabel: 'Choose a cell',
			to: CONTROLS_HREF,
		};
	}

	const retreating = leadingRetreat(managed);
	if (retreating !== null) {
		const decision = retreating.lastDecision;
		return {
			key: 'read_pull_back',
			title: `The controller pulled ${rampCellLabel(retreating.cell)} back`,
			// The controller's own notice where it wrote one, its decision sentence
			// otherwise. Both name the gate that broke; neither is re-worded here.
			detail: decision === null ? '' : (decision.adminNotice ?? decision.message),
			ctaLabel: 'See the evidence behind it',
			to: CELLS_HREF,
		};
	}

	const held = managed.find((cell) => cell.isPaused || cell.pinnedShare !== null);
	if (held !== undefined) {
		return {
			key: 'release_hold',
			title: `You are holding ${rampCellLabel(held.cell)}`,
			detail: held.isPaused
				? 'You paused this cell, so the controller will not move its share in either direction. Nothing is wrong with it — release the pause when you want the ramp to carry on.'
				: `You pinned this cell at ${shareLabel(held.pinnedShare ?? 0)}, so the controller will not raise or lower it. Release the pin when you want the ramp to carry on.`,
			ctaLabel: 'Open the ramp controls',
			to: CONTROLS_HREF,
		};
	}

	if (managed.every((cell) => cell.graduatedAt !== null) && controls.isRelayConfigured) {
		return {
			key: 'disconnect_relay',
			title: 'Consider disconnecting the relay',
			detail:
				'Every cell on the ramp has graduated, so your own server is already carrying their mail. The relay is still connected — the independence screen prices what it is still costing you and names anything still leaning on it.',
			ctaLabel: 'See what the relay still costs',
			to: INDEPENDENCE_HREF,
		};
	}

	const leader = leadingCell(managed.filter((cell) => cell.graduatedAt === null));
	return {
		key: 'watch_evidence',
		title: 'Nothing needs you right now',
		detail:
			leader === null
				? 'The controller is advancing on the evidence. The measurement screen is where the numbers behind each check live.'
				: // The constraint is the controller's own label; the trailing stop is
					// trimmed rather than assumed, because some of those labels carry one
					// ("Waiting for the first evaluation.") and most do not.
					`The controller is advancing on the evidence. What ${rampCellLabel(leader.cell)} is waiting on: ${bindingConstraint(leader).replace(/\.$/, '')}.`,
		ctaLabel: 'See the numbers it is watching',
		to: MEASUREMENT_HREF,
	};
}

/** The most recently retreated cell that is still sitting in that retreat. */
function leadingRetreat(cells: readonly RampCellControl[]): RampCellControl | null {
	let worst: RampCellControl | null = null;
	for (const cell of cells) {
		if (cell.lastDecision?.direction !== 'decrease') continue;
		if (worst === null || cell.lastDecision.at > (worst.lastDecision?.at ?? 0)) worst = cell;
	}
	return worst;
}

// ============ PROGRESSIVE DISCLOSURE ============

export interface RampAdvancedScreen {
	readonly to: string;
	readonly label: string;
	readonly description: string;
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
			label: 'Cells',
			description: 'Every stream and mailbox provider, with the evidence behind each verdict.',
			icon: 'lucide:grid-3x3',
		},
		{
			to: CONTROLS_HREF,
			label: 'Controls',
			description: 'Put a cell on the ramp, hold it, cap it, or change how hard a stream ramps.',
			icon: 'lucide:sliders-horizontal',
		},
		{
			to: MEASUREMENT_HREF,
			label: 'Measurement',
			description: 'Gate by gate, the numbers every verdict on this card was reached on.',
			icon: 'lucide:activity',
		},
		isRelayConfigured
			? {
					to: INDEPENDENCE_HREF,
					label: 'Independence',
					description:
						'How much of your mail your own server now carries, and when the relay stops costing you.',
					icon: 'lucide:trending-up',
				}
			: {
					to: INDEPENDENCE_HREF,
					label: 'Warm-up autopilot',
					description:
						'How much your own server can send today, and what is holding that number back.',
					icon: 'lucide:trending-up',
				},
	];
}
