import type { BounceEffect } from '../../effects.js';

/**
 * The effects that change suppression, reputation or Convex state. A complaint
 * whose provenance stays unknown is still counted; that counter is the one
 * effect it may emit, and it changes nothing.
 */
export function stateChangingEffects(effects: readonly BounceEffect[]): BounceEffect[] {
	return effects.filter(
		(effect) =>
			!(effect.kind === 'metric_inc' && effect.metric === 'fbl_complaint_unknown_provenance')
	);
}
