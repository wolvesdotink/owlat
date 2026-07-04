/**
 * Post-send outcome feedback
 *
 * Captures REAL-WORLD post-send outcomes (angry replies / bounces / complaints,
 * and unedited answered-clarification sends) as autonomy feedback, so the
 * self-tuning loop stays calibrated as auto-send volume grows — outcomes on
 * messages the human never reviewed still tune the thresholds and feed the
 * rejection-spike circuit breaker.
 *
 * Split out of `autonomy.ts` to keep that module under the file-size ratchet;
 * the recorded rows are plain `autonomyFeedback` rows written through the same
 * `internal.autonomyFeedback.recordFeedback` writer the human path uses.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { assertFeatureEnabled } from './lib/featureFlags';
import { extractEmail } from './lib/emailAddress';
import { recordAuditLog } from './lib/auditLog';
import { getSenderRule } from './lib/autonomyRules';

/**
 * The real-world post-send outcome signals that can be captured for a message
 * that was AUTO-sent (or, for the positive clarification case, sent by the
 * owner unedited). Each maps deterministically to an `autonomyFeedback.action`
 * so the existing threshold-adjustment cron and rejection-spike circuit breaker
 * consume them unchanged — an angry reply / bounce / complaint reads as a
 * `rejected`, an unedited answered-clarification send as an `approved`.
 */
export const OUTCOME_SIGNAL = {
	reply_negative: 'rejected',
	bounce: 'rejected',
	complaint: 'rejected',
	clarification_unedited_send: 'approved',
} as const;

export type OutcomeSignal = keyof typeof OUTCOME_SIGNAL;

const outcomeSignalValidator = v.union(
	v.literal('reply_negative'),
	v.literal('bounce'),
	v.literal('complaint'),
	v.literal('clarification_unedited_send')
);

/**
 * Record a real-world post-send OUTCOME as autonomy feedback, attributed to the
 * ORIGINAL auto-sent message's category/sender (not the reply's). This is the
 * second signal source that keeps the self-tuning loop calibrated as auto-send
 * volume grows: outcomes on messages the human never reviewed still tune the
 * thresholds and feed the rejection-spike breaker.
 *
 * Fail-soft and conservative:
 *   - a missing original message is a no-op (nothing to attribute to);
 *   - the category comes from the original message's classification (`other`
 *     when unclassified), so the signal always lands somewhere;
 *   - the caller only ever passes a signal it is CONFIDENT about — a neutral
 *     reply is filtered out UPSTREAM (see agent/outcomeFeedback), never here.
 */
export const recordOutcomeFeedback = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		signal: outcomeSignalValidator,
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return; // original message gone — nothing to attribute

		const category = message.classification?.category ?? 'other';
		const action = OUTCOME_SIGNAL[args.signal as OutcomeSignal];
		const agentConfidence = message.confidenceScore ?? message.classification?.confidence ?? 0;

		await ctx.runMutation(internal.autonomyFeedback.recordFeedback, {
			category,
			action,
			agentConfidence,
			userFeedback: `post-send outcome: ${args.signal}`,
			inboundMessageId: args.inboundMessageId,
			source: 'outcome',
			outcomeSignal: args.signal,
		});

		// First-class INCIDENT: a confirmed BAD auto-send outcome (angry reply /
		// bounce / complaint — all of which map to `rejected`) is not just a
		// calibration data point. It auto-DEMOTES the exact sender/category slice
		// that produced it to draft-only so the agent stops auto-replying to that
		// sender immediately, and records the incident for the autonomy UI to
		// surface. A GOOD outcome (`clarification_unedited_send` → `approved`)
		// never demotes.
		if (action === 'rejected') {
			const sender = extractEmail(message.from ?? '');
			if (sender) {
				await demoteSenderToDraftOnly(ctx, category, sender, args.signal);
			}
		}
	},
});

/**
 * Auto-demote a (category, sender) slice to DRAFT-ONLY after a confirmed bad
 * auto-send outcome. Upserts a DISABLED per-sender autonomy rule (an
 * `isEnabled: false` per-sender rule is the existing "never auto-send this
 * sender" opt-out; see lib/autonomyRules.ts) and stamps the incident markers so
 * the UI can surface it as a first-class alert the operator acknowledges.
 * Idempotent: a repeat bad outcome refreshes the incident timestamp.
 */
async function demoteSenderToDraftOnly(
	ctx: MutationCtx,
	category: string,
	sender: string,
	signal: OutcomeSignal
): Promise<void> {
	const db = ctx.db;
	const now = Date.now();
	const reason = `Auto-demoted to draft-only after a confirmed bad auto-send outcome (${signal})`;
	const existing = await getSenderRule(db, category, sender);

	if (existing) {
		await db.patch(existing._id, {
			isEnabled: false,
			autoDemotedAt: now,
			autoDemotedReason: reason,
			autoDemotedSignal: signal,
			demotionAcknowledgedAt: undefined,
			updatedAt: now,
		});
		return;
	}

	await db.insert('autonomyRules', {
		category,
		sender,
		autoApproveThreshold: 0.9,
		maxDailyAutoActions: 10,
		isEnabled: false,
		autoDemotedAt: now,
		autoDemotedReason: reason,
		autoDemotedSignal: signal,
		createdAt: now,
		updatedAt: now,
	});
}

// ============================================================
// Demotion incidents (user-facing alert surface)
// ============================================================

/**
 * Admin-gated read of unacknowledged auto-demotion incidents for the autonomy
 * settings UI. Each row is a (category, sender) slice that was auto-demoted to
 * draft-only after a confirmed bad auto-send outcome and not yet dismissed.
 * Newest first. Bounded: one row per demoted sender.
 */
export const listAutoDemotions = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		const rows = await ctx.db.query('autonomyRules').collect(); // bounded: category + per-sender rules
		const incidents = [];
		for (const row of rows) {
			if (row.autoDemotedAt != null && row.demotionAcknowledgedAt == null) {
				incidents.push({
					_id: row._id,
					category: row.category,
					sender: row.sender ?? null,
					autoDemotedAt: row.autoDemotedAt,
					autoDemotedReason: row.autoDemotedReason ?? null,
					autoDemotedSignal: row.autoDemotedSignal ?? null,
				});
			}
		}
		incidents.sort((a, b) => b.autoDemotedAt - a.autoDemotedAt);
		return incidents;
	},
});

/**
 * Acknowledge (dismiss) an auto-demotion incident. Clears the alert marker only;
 * the sender stays DRAFT-ONLY (the disabled per-sender rule is untouched) — an
 * operator who wants to re-enable auto-send for the sender does so deliberately
 * via the per-sender toggle. Owner/admin only.
 */
export const acknowledgeAutoDemotion = authedMutation({
	args: { ruleId: v.id('autonomyRules') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage autonomy'
		);
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		const rule = await ctx.db.get(args.ruleId);
		if (!rule || rule.autoDemotedAt == null) return null; // already cleared — idempotent
		await ctx.db.patch(args.ruleId, { demotionAcknowledgedAt: Date.now() });
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'agent.demotion_acknowledged',
			resource: 'autonomy_rule',
			resourceId: args.ruleId,
			details: { category: rule.category, sender: rule.sender ?? null },
		});
		return null;
	},
});

/**
 * Load the fields the outcome-classification action needs about a prior
 * auto-sent message: whether it was actually AUTO-sent (so a human-reviewed
 * send is never mislabeled) and the linked original message id. Session-less
 * — consumed by the `agent/outcomeFeedback` node action.
 */
export const getReplyOutcomeContext = internalQuery({
	args: { replyMessageId: v.id('inboundMessages') },
	handler: async (
		ctx,
		args
	): Promise<{ wasAutoSent: boolean; originalMessageId: Id<'inboundMessages'> } | null> => {
		const reply = await ctx.db.get(args.replyMessageId);
		if (!reply?.threadId) return null;

		// Find the most recent PRIOR message on the thread that the agent
		// AUTO-sent (route step's `auto_approve` decision that reached `sent`).
		// Scan newest-first and stop at the first auto-sent original.
		const priors = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', reply.threadId))
			.order('desc')
			.take(50);

		for (const prior of priors) {
			if (prior._id === reply._id) continue;
			if (prior.receivedAt >= reply.receivedAt) continue; // must precede the reply
			if (prior.processingStatus === 'sent' && prior.agentDecision?.decision === 'auto_approve') {
				return { wasAutoSent: true, originalMessageId: prior._id };
			}
		}
		return null;
	},
});
