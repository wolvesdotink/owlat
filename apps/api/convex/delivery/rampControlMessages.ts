/**
 * WHAT THE OPERATOR'S CONTROLS SAY ON THE RECORD, AND WHICH DIAL THEY NAME.
 *
 * A `mixDecisions` message outlives every screen that rendered it: an operator
 * reading a cell's timeline six weeks later has the sentence and nothing else. So
 * the sentences are their own module, beside `rampControlAudit.ts` (which writes
 * the pair of rows) and away from `rampControls.ts` (which enforces the rules) —
 * one job per file, and the file that grew past the conventions' ~500 LOC line
 * split along the seam that was already there.
 *
 * EVERY SENTENCE HERE IS CUT ON ONE READING: which dial the controller is
 * ramping this cell on. Both controls are expressed in SHARE, and on a cell the
 * tick ramps by PACE that is not the dial that is climbing — so a row worded
 * without asking would tell an operator to watch a number that was never the one
 * moving.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx } from '../_generated/server';
import { loadCellDegradation } from './rampIntegrationPresence';
import { bindsPhaseLadder } from './ramp/degradation';

/** The cell a control resolved to, as much of it as a sentence needs. */
export interface RampControlTarget {
	readonly organizationId: string;
	readonly cell: DeliverabilityCell;
}

/**
 * WHICH DIAL IS THIS CELL'S RAMP — the tick's own answer to its own question.
 *
 * `bindsPhaseLadder` is `actuator === 'share'`, read off the same substitution
 * resolution that chooses the cell's evaluator, its K_CLEAN and its ceiling cap
 * (plan D3). What the audit row TELLS an operator depends on it, and a control
 * that named the dial the controller is NOT climbing would be read back for ever.
 *
 * DELIBERATELY NOT `hasSecondSender`, which is what the two phase doors cut on.
 * That union also counts a relay that is CONFIGURED but carried nothing this
 * window, and the tick does not: it ramps by pace on every cell whose reference
 * arm it cannot measure. A sentence worded off the union would promise the share
 * as the climbing dial on a cell the next tick ramps by pace. Whether a relay is
 * configured is a second, separate fact, and it stays out of these sentences
 * rather than being soldered onto the dial claim.
 *
 * One helper over one loaded degradation — reading it twice inside one mutation
 * would let two halves of one sentence answer off two different ticks.
 */
export async function readsShareDial(
	ctx: MutationCtx,
	target: RampControlTarget,
	now: number
): Promise<boolean> {
	return bindsPhaseLadder(
		await loadCellDegradation(ctx, {
			organizationId: target.organizationId,
			cell: target.cell,
			now,
		})
	);
}

/**
 * THE AUDIT SENTENCE, AND IT NAMES THE DIAL THE CONTROLLER WAS RAMPING.
 *
 * Two outcomes, cut on the tick's own actuator reading (`readsShareDial`): one
 * question about one cell, answered once, so its timeline cannot end up carrying
 * two accounts of which dial this deployment climbs.
 *
 * BOTH ARMS NAME BOTH DIALS, because the pause holds both. What differs is which
 * one the controller was actually advancing — the number an operator watches
 * after leaving a pause in place — and neither sentence claims the other dial
 * stands still: the share of a pace-actuated cell is still decided and still
 * written on every tick, and a hard stop still takes it down.
 *
 * THE ONE-DIRECTIONAL RULE IS SAID ON BOTH ARMS on purpose. It is the property an
 * operator is trusting when they leave a pause in place overnight, and a
 * deployment that read it on one arm only would have to guess about the other.
 */
export function pauseMessage(args: {
	readonly cell: DeliverabilityCell;
	readonly share: number;
	readonly isPaused: boolean;
	readonly rampsShare: boolean;
}): string {
	const key = deliverabilityCellKey(args.cell);
	const percent = `${Math.round(args.share * 100)}%`;
	if (args.rampsShare) {
		return args.isPaused
			? `An operator paused ${key} at ${percent}. The share is the dial the controller is ramping here, and the warm-up pace is held with it. The gates keep measuring and a retreat would still be applied — only the increase is held.`
			: `An operator resumed ${key}. The share and the warm-up pace may advance again when the gates allow it.`;
	}
	return args.isPaused
		? `An operator paused ${key} at ${percent}. No reference transport is carrying this cell, so the warm-up pace is the dial the controller is ramping here, and the share is held with it. The gates keep measuring and a retreat would still be applied — only the increase is held.`
		: `An operator resumed ${key}. The warm-up pace and the share may advance again when the gates allow it.`;
}

/**
 * THE PIN'S SENTENCE, on the same reading and for a sharper reason.
 *
 * A pin is expressed in SHARE, and the tick decides and writes a share for every
 * managed cell whichever dial it ramps, so the cap itself always binds. What it
 * cannot bind is the PACE dial — a multiplier on a daily cap, in units no share
 * converts into. On a cell the controller ramps by pace the cap therefore holds
 * the dial that is not climbing, and the row names the control that holds the
 * other one rather than letting an operator walk away believing the cell is
 * capped. The pin binds the climbing dial again the tick a reference transport is
 * measured, which is the rule both phase doors state from their own side.
 */
export function pinMessage(args: {
	readonly cell: DeliverabilityCell;
	readonly pinned: number | null;
	readonly rampsShare: boolean;
}): string {
	const key = deliverabilityCellKey(args.cell);
	if (args.pinned === null) {
		return args.rampsShare
			? `An operator unpinned ${key}. The ramp may climb again when the gates allow it.`
			: `An operator unpinned ${key}. The share may climb again when the gates allow it; the warm-up pace, the dial the controller is ramping here, was never bounded by the pin.`;
	}
	const percent = `${Math.round(args.pinned * 100)}%`;
	return args.rampsShare
		? `An operator pinned ${key} at ${percent}. The ramp will not climb past that share until it is unpinned.`
		: `An operator pinned ${key} at ${percent}. The share will not climb past it, but no reference transport is carrying this cell: the warm-up pace is the dial the controller is ramping here, and no pin can bound it — pausing the cell is what holds it.`;
}
