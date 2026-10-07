/**
 * The Postbox projection of an interpretation (SPEC §5 "Postbox"): turn a run's
 * {@link NeedsReplyProjection} into the `mailThreads.needsReply` write the
 * classifier used to make from its own refinement call.
 *
 * The server still decides: `decideNeedsReply` takes the interpretation's
 * reply intent, the unattended-sender screen, and as the "model's boolean"
 * the one veto the items carry: when every item is someone else's, the reader
 * is not the one asked. An actionable item alone never implies a reply (an
 * informational intent stays out of the queue whatever items it has).
 *
 * `askSummary` is the top item the reader owns, in the owner's locale;
 * `dueHint` its deadline. Clarification, memory fills, pending/retry and the
 * heuristic baseline stay with the caller (`mail/ai/needsReplyClassify.ts`),
 * which passes its clarification through here unchanged.
 */

import type { Infer } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import {
	decideNeedsReply,
	normalizeDueHint,
	normalizeMeetingIntent,
	REPLY_INTENTS,
	type ReplyDecision,
	type ReplyIntent,
} from '../ai/replyIntent';
import { isUnattendedAddress } from '../needsReplyHeuristic';
import type { needsReplyClarificationArgValidator } from '../../lib/validators/clarification';
import type { NeedsReplyProjection } from './pipeline';

export interface LatestInbound {
	messageId: Id<'mailMessages'>;
	fromAddress: string;
	hasCalendarInvite: boolean;
}

function asReplyIntent(value: string): ReplyIntent {
	return (REPLY_INTENTS as readonly string[]).includes(value)
		? (value as ReplyIntent)
		: 'informational_update';
}

/** The decision and the `applyResult` value it implies. Pure. */
export function needsReplyResultOf(
	projection: NeedsReplyProjection,
	latest: LatestInbound,
	clarification?: Infer<typeof needsReplyClarificationArgValidator>
) {
	const decision: ReplyDecision = decideNeedsReply({
		intent: asReplyIntent(projection.replyIntent),
		modelNeedsReply: !projection.isOnlyTheirs,
		isUnattendedSender: isUnattendedAddress(latest.fromAddress),
	});
	if (!decision.needsReply) return { decision, needsReply: null };
	const meetingIntent = normalizeMeetingIntent(
		projection.meetingIntent
			? {
					isScheduling: projection.meetingIntent.isScheduling,
					proposedTimes: projection.meetingIntent.proposedTimes,
					topic: projection.meetingIntent.topic ?? null,
				}
			: null,
		{ hasCalendarInvite: latest.hasCalendarInvite }
	);
	const dueHint = normalizeDueHint(projection.dueHint ?? null);
	return {
		decision,
		needsReply: {
			messageId: latest.messageId,
			source: 'llm' as const,
			urgency: projection.urgency,
			...(projection.askSummary ? { askSummary: projection.askSummary.slice(0, 120) } : {}),
			...(dueHint ? { dueHint } : {}),
			...(meetingIntent ? { meetingIntent } : {}),
			...(clarification ? { clarification } : {}),
		},
	};
}

/**
 * Write the projection through `mail/needsReply.applyResult` (stale guard,
 * scoring, screener, draft-on-arrival all apply). Returns the decision so the
 * caller can decide whether to run its clarification pass first; call it
 * again with the clarification when it has one.
 */
export async function projectNeedsReply(
	ctx: ActionCtx,
	args: {
		threadId: Id<'mailThreads'>;
		expectedLatestMessageId?: Id<'mailMessages'>;
		latestInbound: LatestInbound;
		projection: NeedsReplyProjection;
		clarification?: Infer<typeof needsReplyClarificationArgValidator>;
	}
): Promise<ReplyDecision> {
	const { decision, needsReply } = needsReplyResultOf(
		args.projection,
		args.latestInbound,
		args.clarification
	);
	await ctx.runMutation(internal.mail.needsReply.applyResult, {
		threadId: args.threadId,
		...(args.expectedLatestMessageId ? { expectedLatestMessageId: args.expectedLatestMessageId } : {}),
		needsReply,
	});
	return decision;
}
