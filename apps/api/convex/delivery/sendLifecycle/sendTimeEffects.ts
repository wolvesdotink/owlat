import type { Id } from '../../_generated/dataModel';
import { DAY_MS } from '../../lib/constants';
import type { CampaignStatField } from '../../lib/validators/campaigns';
import type { SendTimeGroup } from '../../lib/validators/sendTime';
import type { SendTimeEngagementKind } from '../../analytics/sendTimeProfile';
import type { OpenAgent } from '../automatedOpens';
import type { EmailSendDoc, SendRef, TransactionalSendDoc } from './types';

// ============================================================================
// Send lifecycle — the send-time optimization hooks (ADR-0068).
//
// Two things ride on the reducers' existing effect list:
//
// 1. The comparison counters. A campaign send planned by the send-time
//    optimizer carries `sendTimeGroup`; its delivered / first reader open /
//    first reader click bump that arm's counters in the SAME shard write as
//    the campaign's own counter. An open or click only counts for its arm
//    within `SEND_TIME_ATTRIBUTION_MS` of the send going out, so both arms are
//    measured over the same exposure: the holdout goes out first and would
//    otherwise have had up to a whole window longer to collect engagement.
// 2. The engagement that teaches the profile: the first reader open of a
//    campaign send that our pixel judged to be a mail client, and the first
//    reader click. Provider-reported opens (no `agent`) are left out because
//    nothing says who fetched them; automated opens and clicks never reach
//    here (the reducers branch them off first).
//
// Kept apart from `effects.ts` so the reducers stay under the file-size cap
// and this module imports nothing back from the runner.
// ============================================================================

/** Fold one reader engagement into the contact's send-time profile. */
export type SendTimeEngagementEffect = {
	kind: 'send_time_engagement';
	contactId: Id<'contacts'>;
	engagement: SendTimeEngagementKind;
	at: number;
};

/**
 * How long after a send goes out its first reader open or click still counts
 * for its arm. The report waits this long after the last send before it
 * compares the arms (`apps/web/app/utils/sendTimeComparison.ts`).
 */
export const SEND_TIME_ATTRIBUTION_MS = DAY_MS;

/**
 * The `sendTimeGroup` to spread onto a `campaign_stats_*` effect, if any. Pass
 * `engagedAt` for an open or click: one later than `SEND_TIME_ATTRIBUTION_MS`
 * after the send went out still bumps the campaign counter, not the arm's.
 */
export function sendTimeGroupOf(
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef,
	engagedAt?: number
): { sendTimeGroup?: SendTimeGroup } {
	if (ref.kind !== 'campaign') return {};
	const { sendTimeGroup: group, sentAt } = send as EmailSendDoc;
	if (group === undefined) return {};
	if (
		engagedAt !== undefined &&
		sentAt !== undefined &&
		engagedAt - sentAt > SEND_TIME_ATTRIBUTION_MS
	) {
		return {};
	}
	return { sendTimeGroup: group };
}

/**
 * The profile effect for a reader engagement. Call it only on a send's FIRST
 * reader open or click, the same uniqueness gate as the campaign counters, so
 * someone re-reading one email five times is one engagement, not five.
 */
export function sendTimeEngagementEffects(
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef,
	engagement: SendTimeEngagementKind,
	at: number,
	agent?: OpenAgent
): SendTimeEngagementEffect[] {
	if (ref.kind !== 'campaign' || !send.contactId) return [];
	// A complaint ends what the contact's profile learns from this send (#1225).
	if (send.status === 'complained') return [];
	if (engagement === 'open' && agent !== 'client') return [];
	return [{ kind: 'send_time_engagement', contactId: send.contactId, engagement, at }];
}

const ARM_FIELDS = {
	optimized: {
		delivered: 'statsSendTimeOptimizedDelivered',
		opened: 'statsSendTimeOptimizedOpened',
		clicked: 'statsSendTimeOptimizedClicked',
	},
	holdout: {
		delivered: 'statsSendTimeHoldoutDelivered',
		opened: 'statsSendTimeHoldoutOpened',
		clicked: 'statsSendTimeHoldoutClicked',
	},
} as const satisfies Record<SendTimeGroup, Record<string, CampaignStatField>>;

/** The extra counter delta for a send in an optimization arm; empty otherwise. */
export function sendTimeStatDelta(
	group: SendTimeGroup | undefined,
	event: 'delivered' | 'opened' | 'clicked'
): Partial<Record<CampaignStatField, number>> {
	return group === undefined ? {} : { [ARM_FIELDS[group][event]]: 1 };
}
