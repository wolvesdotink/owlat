/**
 * The two numbers that make pressing "Send campaign" survivable, in one place
 * because three surfaces have to agree on them: the wizard's Review step, the
 * campaign editor (`useCampaignActions`) and the undo toast that counts the
 * window down.
 *
 * The policy is the plan's (UX_IMPROVEMENT_PLAN_2026-09-01, T3): an undo window
 * beats a confirmation dialog for the common case, and a dialog survives only
 * where the blast radius earns the interruption.
 */

/**
 * Recipients at or above which a send asks for an explicit confirmation naming
 * the campaign and the audience size.
 *
 * Below it a send is a small, recoverable act — a team of twelve, a test list —
 * and a modal in front of every one of those taxes the common case to protect
 * against a rare mistake. The undo window (below) covers that case instead.
 */
const SEND_CONFIRM_AUDIENCE_THRESHOLD = 50;

/**
 * How long a "send now" is held before it actually goes out, so the undo toast
 * has something to cancel.
 *
 * Expressed as a real scheduled start rather than a client-side delay: the
 * server contract is unchanged (`campaigns.scheduling.schedule` + its cancel),
 * so a closed tab still sends and a cancel is a real state transition rather
 * than a `clearTimeout` nobody can see.
 */
export const SEND_UNDO_WINDOW_MS = 60_000;

/**
 * Whether a send to `audienceCount` recipients has to be confirmed first.
 *
 * An unknown count (the audience query has not resolved, or the step was
 * reached without one) confirms: not knowing how big the blast is is exactly
 * when you want to be asked.
 */
export function needsSendConfirmation(audienceCount: number | null | undefined): boolean {
	if (typeof audienceCount !== 'number' || !Number.isFinite(audienceCount)) return true;
	return audienceCount >= SEND_CONFIRM_AUDIENCE_THRESHOLD;
}
