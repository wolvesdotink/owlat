/**
 * THE COMPOSITION ORDER — one controller, two actuators, a FIXED order between
 * them (plan D3).
 *
 * When both actuators exist they do NOT compose commutatively:
 *
 *   SHARE moves FIRST. It is cheap and instantly reversible — the relay absorbs
 *   the difference, and a share that went up too far can be taken back inside
 *   one window with no lasting cost.
 *
 *   PACE moves SECOND. It is slow and REPUTATION-BEARING: a warming cap that
 *   grew too fast is not undone by lowering it again, because the volume has
 *   already reached the receiver.
 *
 * AND A CELL MAY NEVER INCREASE BOTH IN THE SAME WINDOW. Two reputation-bearing
 * dials moving together is exactly the experiment whose result nobody can read:
 * if the next window degrades, which move caused it? So when the share
 * increases, the pace increase is DEFERRED to the next window rather than
 * cancelled — and deliberately does not count the UTC day, so tomorrow's tick
 * can still take the step it was owed.
 *
 * WHAT IS NOT INTERLOCKED, and why. RETREATS compose freely in both directions
 * and at the same time: the asymmetry in D9 is the whole point, and a rule that
 * made a share retreat delay a pace retreat would ration the one thing that must
 * never be rationed. A HOLD on either side constrains nothing.
 *
 * STANDALONE IS THE DEGENERATE CASE, not a branch: with no reference transport
 * there is no share decision at all (`share: null`), the interlock has nothing
 * to interlock, and the pace decision passes through untouched. That is the
 * substitution table, not an if-branch scattered through the controller.
 *
 * Pure: this is a total function of two decisions.
 */

import type { RampDecision } from './controllerTypes';
import type { PaceDecision } from './paceTypes';

export interface ActuatorCompositionInput {
	/** The share decision, or `null` for a standalone deployment (s === 1). */
	readonly share: RampDecision | null;
	readonly pace: PaceDecision;
}

export interface ComposedActuators {
	/** The share decision, applied FIRST and never modified by composition. */
	readonly share: RampDecision | null;
	/** The pace decision, applied SECOND — possibly deferred by the interlock. */
	readonly pace: PaceDecision;
	/**
	 * Whether the interlock held the pace increase back this window. Recorded
	 * rather than inferred: `pace.reason` says `share_moved_first`, but a caller
	 * writing an audit row should not have to compare a string to know that a
	 * decision was overridden (plan D12).
	 */
	readonly isPaceDeferred: boolean;
}

/**
 * Apply the interlock. The SHARE decision is returned exactly as it came in —
 * this function can only ever hold the PACE dial back, never move either one.
 */
export function composeActuators(input: ActuatorCompositionInput): ComposedActuators {
	const { share, pace } = input;
	const isBothIncreasing = share?.direction === 'increase' && pace.direction === 'increase';
	if (!isBothIncreasing) return { share, pace, isPaceDeferred: false };

	return {
		share,
		pace: {
			...pace,
			multiplier: pace.fromMultiplier,
			direction: 'hold',
			reason: 'share_moved_first',
			// NO FREEZE and NO COUNTED DAY. The window was clean and the pace
			// actuator earned its step; it is being asked to wait, not penalised. Both
			// omissions matter: a freeze would cost the cell hours it never lost, and
			// counting the day would spend the increase the interlock just withheld.
			freeze: undefined,
			countedUtcDay: undefined,
		},
		isPaceDeferred: true,
	};
}
