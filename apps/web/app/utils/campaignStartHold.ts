/**
 * A scheduled campaign the start gate is holding at its start time
 * (`campaigns/startGate.ts`): still `scheduled`, past its time, waiting for
 * delivery to come back for at most a few hours before it returns to draft.
 * The gate records the wait on the campaign as `startHold`; these helpers
 * decide whether a recorded wait still describes the campaign and word it.
 *
 * Module scope, so the copy is catalog keys; the surfaces resolve them.
 */

/** The wait as the campaign stores it. */
export interface StoredStartHold {
	reason: string;
	/** The start being held. */
	scheduledAt: number;
	/** When the gate stops waiting and returns the campaign to draft. */
	givesUpAt: number;
}

interface HoldableCampaign {
	status?: string;
	scheduledAt?: number | null;
	startHold?: StoredStartHold | null;
}

/**
 * The wait the campaign is in right now, or `null`. A recorded wait counts only
 * while the campaign is still `scheduled` for the start it was written for: the
 * backend clears it on every transition, and this keeps a page that reads a
 * moment-old row from showing a wait that already ended.
 */
export function activeStartHold(
	campaign: HoldableCampaign | null | undefined
): StoredStartHold | null {
	const hold = campaign?.startHold;
	if (!hold || campaign?.status !== 'scheduled') return null;
	return campaign.scheduledAt === hold.scheduledAt ? hold : null;
}

const REASON_SEGMENT: Readonly<Record<string, string>> = {
	delivery_on_hold: 'deliveryOnHold',
	mail_server_not_ready: 'mailServerNotReady',
};

/** A reason a newer backend added still reads as a wait, in general words. */
function segment(hold: StoredStartHold): string {
	return REASON_SEGMENT[hold.reason] ?? 'unknown';
}

/** The sentence naming why the start is waiting. */
export function startHoldReasonKey(hold: StoredStartHold): string {
	return `shared.campaignStartHold.reasons.${segment(hold)}`;
}

/** The one-line form for a campaign list row; it interpolates `{when}`. */
export function startHoldRowMetaKey(hold: StoredStartHold): string {
	return `shared.campaignStartHold.rowMeta.${segment(hold)}`;
}

/**
 * The instant to word as "gives up {when}". The scheduler tick that gives up
 * can run a little after `givesUpAt`; until it does, the wait reads as ending
 * now rather than as having ended in the past.
 */
export function startHoldGivesUpAt(hold: StoredStartHold, now: number): number {
	return Math.max(hold.givesUpAt, now + 60_000);
}
