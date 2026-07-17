import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Slack approvals reference app tables (Tier-2 connected app, PP-26).
 *
 * One row per autonomous send the app is holding for Slack-side quorum. The row
 * is the app's ENTIRE authority: it can only ever RECORD approve/reject votes,
 * and the restrict-only hold gate reads it to decide whether to keep holding.
 * Nothing in this table can approve a message, unblock a core gate, or send.
 *
 * Spread into `defineSchema()` from schema.ts via `...slackApprovalTables`.
 */
export const slackApprovalTables = {
	slackApprovalRequests: defineTable({
		// Singleton-org tenant scope — every read/write is confined to it.
		organizationId: v.string(),
		// The autonomous send this request gates.
		inboundMessageId: v.id('inboundMessages'),
		// Opaque, unguessable token embedded in the Slack message and echoed back
		// on the callback. The callback looks the request up by this, never by a
		// raw Convex id.
		approvalToken: v.string(),
		// Distinct Slack approvers required to release the hold (>= 1).
		quorum: v.number(),
		// Epoch ms after which approve votes no longer count (fail-closed to hold).
		expiresAt: v.number(),
		createdAt: v.number(),
		// Recorded votes. Duplicate votes from one Slack user collapse to the first
		// (see approvalState.effectiveVotes); the array is append-only.
		votes: v.array(
			v.object({
				slackUserId: v.string(),
				decision: v.union(v.literal('approve'), v.literal('reject')),
				votedAt: v.number(),
			})
		),
		// Outbound Slack notification lifecycle. A failed/omitted notification NEVER
		// releases the hold — it only means humans were not asked yet.
		notifyStatus: v.union(
			v.literal('pending'),
			v.literal('sent'),
			v.literal('failed'),
			v.literal('skipped')
		),
		notifyAttempts: v.number(),
		// Redacted failure reason for operator debugging (never the secret or body).
		notifyError: v.optional(v.string()),
	})
		// Callback lookup by the opaque token.
		.index('by_token', ['approvalToken'])
		// Gate lookup: the current request for a message in this tenant.
		.index('by_org_and_message', ['organizationId', 'inboundMessageId']),
};
