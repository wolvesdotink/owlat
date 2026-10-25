/**
 * The readers behind Today's Upcoming band (`./upcoming.ts`): one function per
 * kind of thing that is already set to happen later. Each reads lightweight
 * metadata through an index ordered by the time it happens, so the earliest
 * rows come first and nothing is scanned past the page.
 *
 * Every reader returns at most `want` items in time order. `horizon` is set
 * when the reader stopped before it could prove it found the first `want`
 * (only the snooze reader, which de-duplicates conversations under a scan
 * cap): items of this kind later than `horizon` may exist unlisted.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { dedupedRecipients } from '../mail/draftLifecycle/reducers';
import { audienceCountTarget, findAudienceCountJob } from '../campaigns/audienceCountState';
import type { StoredAudience } from '../campaigns/audience';

interface MailboxRef {
	mailboxId: Id<'mailboxes'>;
	/** The mailbox's display name, else its address (as the inbox switcher shows it). */
	mailboxLabel: string;
}

export type UpcomingItem =
	| (MailboxRef & {
			kind: 'scheduled_send';
			key: string;
			at: number;
			draftId: Id<'mailDrafts'>;
			subject: string;
			firstRecipient: string | null;
			recipientCount: number;
			/** Set on a reply: the composer reopens it on the message it answers. */
			inReplyToMessageId: Id<'mailMessages'> | null;
	  })
	| (MailboxRef & {
			kind: 'snooze_return';
			key: string;
			at: number;
			threadId: Id<'mailThreads'>;
			messageId: Id<'mailMessages'>;
			subject: string;
			from: string;
			/** "Until they reply": `at` is the latest it comes back, a reply brings it sooner. */
			isUntilReply: boolean;
	  })
	| (MailboxRef & {
			kind: 'follow_up';
			key: string;
			at: number;
			threadId: Id<'mailThreads'>;
			messageId: Id<'mailMessages'>;
			subject: string;
			waitingOn: string | null;
	  })
	| {
			kind: 'team_snooze_return';
			key: string;
			at: number;
			threadId: Id<'conversationThreads'>;
			subject: string;
			contact: string;
	  }
	| {
			kind: 'campaign';
			key: string;
			at: number;
			campaignId: Id<'campaigns'>;
			name: string;
			/**
			 * `absolute`: everyone at `at`. `recipient_local`: `localTime` in each
			 * recipient's time zone, so `at` is only an approximation. `optimized`:
			 * each recipient at their usual reading hour, starting at `at`.
			 */
			timing: 'absolute' | 'recipient_local' | 'optimized';
			localTime: { hour: number; minute: number } | null;
			audienceName: string | null;
			/** The last exact audience count, or null when none was ever finished. */
			recipients: { count: number; countedAt: number } | null;
	  };

export interface SourceResult {
	items: UpcomingItem[];
	horizon?: number;
}

/** Snoozed messages scanned per wanted conversation (a conversation snoozes all its inbox messages). */
const SNOOZE_SCAN_PER_ITEM = 4;

export function mailboxRefOf(mailbox: Doc<'mailboxes'>): MailboxRef {
	const displayName = mailbox.displayName?.trim();
	return {
		mailboxId: mailbox._id,
		mailboxLabel: displayName && displayName.length > 0 ? displayName : mailbox.address,
	};
}

/** Sends this mailbox has scheduled, soonest first (including any whose time just passed). */
export async function readScheduledSends(
	ctx: QueryCtx,
	ref: MailboxRef,
	want: number
): Promise<SourceResult> {
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_mailbox_state_and_scheduled', (q) =>
			q.eq('mailboxId', ref.mailboxId).eq('state', 'scheduled')
		)
		.take(want);
	return {
		items: drafts.flatMap((draft) =>
			draft.scheduledSendAt === undefined
				? []
				: [
						{
							...ref,
							kind: 'scheduled_send' as const,
							key: `send:${draft._id}`,
							at: draft.scheduledSendAt,
							draftId: draft._id,
							subject: draft.subject,
							firstRecipient: draft.toAddresses[0] ?? draft.ccAddresses[0] ?? null,
							recipientCount: dedupedRecipients(draft).length,
							inReplyToMessageId: draft.inReplyToMessageId ?? null,
						},
					]
		),
	};
}

/**
 * Conversations coming back from snooze, by the earliest time any of their
 * messages wakes (the sweep wakes each message at its own time). A thread
 * snooze stamps every inbox message, so the scan is capped at a multiple of
 * `want` and reports a horizon when the cap cut it short.
 */
export async function readSnoozeReturns(
	ctx: QueryCtx,
	ref: MailboxRef,
	want: number,
	now: number
): Promise<SourceResult> {
	const cap = want * SNOOZE_SCAN_PER_ITEM;
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_snoozed', (q) =>
			q.eq('mailboxId', ref.mailboxId).gt('snoozedUntil', now)
		)
		.take(cap);
	const items: UpcomingItem[] = [];
	const seen = new Set<Id<'mailThreads'>>();
	for (const message of messages) {
		if (items.length >= want) break;
		if (message.snoozedUntil === undefined || seen.has(message.threadId)) continue;
		seen.add(message.threadId);
		items.push({
			...ref,
			kind: 'snooze_return',
			key: `snooze:${message.threadId}`,
			at: message.snoozedUntil,
			threadId: message.threadId,
			messageId: message._id,
			subject: message.subject,
			from: message.fromName?.trim() || message.fromAddress,
			isUntilReply: message.isSnoozeUntilReply === true,
		});
	}
	if (items.length >= want) return { items };
	const last = messages[messages.length - 1];
	return messages.length === cap && last?.snoozedUntil !== undefined
		? { items, horizon: last.snoozedUntil }
		: { items };
}

/** Armed "remind me if no reply" watches, soonest first. A due watch has no remind time left. */
export async function readFollowUps(
	ctx: QueryCtx,
	ref: MailboxRef,
	want: number,
	now: number
): Promise<SourceResult> {
	const threads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_follow_up_remind', (q) =>
			q.eq('mailboxId', ref.mailboxId).gt('followUpRemindAt', now)
		)
		.take(want);
	return {
		items: threads.flatMap((thread) =>
			thread.followUpRemindAt === undefined || thread.followUp === undefined
				? []
				: [
						{
							...ref,
							kind: 'follow_up' as const,
							key: `followup:${thread._id}`,
							at: thread.followUpRemindAt,
							threadId: thread._id,
							messageId: thread.followUp.messageId,
							subject: thread.latestSubject,
							waitingOn: thread.followUp.waitingOn ?? null,
						},
					]
		),
	};
}

/** Team Inbox conversations coming back from snooze (shared-inbox readers only; the caller checks). */
export async function readTeamSnoozeReturns(
	ctx: QueryCtx,
	want: number,
	now: number
): Promise<SourceResult> {
	const threads = await ctx.db
		.query('conversationThreads')
		.withIndex('by_snoozed_until', (q) => q.gt('snoozedUntil', now))
		.take(want);
	return {
		items: threads.flatMap((thread) =>
			thread.snoozedUntil === undefined
				? []
				: [
						{
							kind: 'team_snooze_return' as const,
							key: `team:${thread._id}`,
							at: thread.snoozedUntil,
							threadId: thread._id,
							subject: thread.subject,
							contact: thread.contactIdentifier,
						},
					]
		),
	};
}

async function audienceNameOf(ctx: QueryCtx, audience: StoredAudience): Promise<string | null> {
	const row =
		audience.kind === 'topic'
			? await ctx.db.get(audience.topicId)
			: await ctx.db.get(audience.segmentId);
	return row?.name ?? null;
}

/**
 * The last exact count of the audience, from the wizard's count job. Never
 * counted here: scanning an audience is a job's work, so a campaign whose
 * audience was never counted shows no number rather than a guess.
 */
async function audienceRecipientsOf(
	ctx: QueryCtx,
	audience: StoredAudience
): Promise<{ count: number; countedAt: number } | null> {
	const target = await audienceCountTarget(ctx, audience);
	if (!target) return null;
	const job = await findAudienceCountJob(ctx, target);
	if (!job) return null;
	if (job.status === 'complete') {
		return { count: job.eligible, countedAt: job.completedAt ?? job.updatedAt };
	}
	// A recount keeps serving the previous complete result until it finishes.
	if (job.lastEligible !== undefined && job.lastCountedAt !== undefined) {
		return { count: job.lastEligible, countedAt: job.lastCountedAt };
	}
	return null;
}

/** Live scheduled campaigns, soonest first. Recently deleted ones never reach the page. */
export async function readScheduledCampaigns(ctx: QueryCtx, want: number): Promise<SourceResult> {
	const campaigns = await ctx.db
		.query('campaigns')
		.withIndex('by_deleted_at_and_status_and_scheduled_at', (q) =>
			q.eq('deletedAt', undefined).eq('status', 'scheduled').gt('scheduledAt', 0)
		)
		.take(want);
	const items: UpcomingItem[] = [];
	for (const campaign of campaigns) {
		if (campaign.scheduledAt === undefined) continue;
		const isLocal = campaign.useRecipientTimezone === true;
		items.push({
			kind: 'campaign',
			key: `campaign:${campaign._id}`,
			at: campaign.scheduledAt,
			campaignId: campaign._id,
			name: campaign.name,
			timing: isLocal
				? 'recipient_local'
				: campaign.sendTimeOptimization
					? 'optimized'
					: 'absolute',
			localTime:
				isLocal && campaign.scheduledHour !== undefined
					? { hour: campaign.scheduledHour, minute: campaign.scheduledMinute ?? 0 }
					: null,
			audienceName: campaign.audience ? await audienceNameOf(ctx, campaign.audience) : null,
			recipients: campaign.audience ? await audienceRecipientsOf(ctx, campaign.audience) : null,
		});
	}
	return { items };
}
