/**
 * Slack approvals reference app — Convex data plane (Tier-2 connected app,
 * PP-26). The mutations here are the app's ENTIRE authority over an autonomous
 * send, and that authority is deliberately narrow:
 *
 *   - `ensureHold` creates (once) the hold record for a message and schedules
 *     the Slack notification; it can report only "release" (quorum already met)
 *     or "hold". It never sends and never writes to `inboundMessages`.
 *   - `recordApprovalVote` appends one deduplicated vote. It touches nothing but
 *     this table — no message state, no send, no gate bypass.
 *   - `setNotifyOutcome` records whether the Slack post succeeded. A failed post
 *     never releases a hold; it only means humans were not asked yet.
 *
 * Every function is `internal*` — none is reachable from the public client API.
 * Reads/writes are confined to the singleton org.
 */

import { nanoid } from 'nanoid';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation, internalQuery } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import {
	deriveApprovalStatus,
	voteToRecord,
	type SlackApprovalStatus,
	type SlackApprovalVote,
} from './approvalState';

const APPROVAL_TOKEN_BYTES = 32;

/**
 * Ensure a hold record exists for `inboundMessageId` and report whether it is
 * already released (quorum-approved and unexpired). Creating the record also
 * schedules the Slack notification transactionally, so the "ask Slack" side
 * effect commits with the hold. Idempotent: a record already present is reused,
 * never duplicated.
 */
export const ensureHold = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		quorum: v.number(),
		ttlMs: v.number(),
	},
	handler: async (ctx, args): Promise<{ release: boolean; status: SlackApprovalStatus }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const existing = await ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_org_and_message', (q) =>
				q.eq('organizationId', organizationId).eq('inboundMessageId', args.inboundMessageId)
			)
			.unique();

		if (existing) {
			const status = deriveApprovalStatus(existing, Date.now());
			return { release: status === 'approved', status };
		}

		const now = Date.now();
		const approvalToken = nanoid(APPROVAL_TOKEN_BYTES);
		await ctx.db.insert('slackApprovalRequests', {
			organizationId,
			inboundMessageId: args.inboundMessageId,
			approvalToken,
			quorum: args.quorum,
			expiresAt: now + args.ttlMs,
			createdAt: now,
			votes: [],
			notifyStatus: 'pending',
			notifyAttempts: 0,
		});
		// Ask Slack to review. A failed post never releases the hold.
		await ctx.scheduler.runAfter(0, internal.slack.notify.postApprovalRequest, { approvalToken });
		return { release: false, status: 'pending' };
	},
});

/**
 * Record one Slack vote against the request identified by its opaque token.
 * Duplicate / replayed / vote-flip attempts from an already-voted Slack user are
 * inert (first vote wins). Returns only whether a NEW vote was stored and the
 * resulting status — the caller (the signed HTTP endpoint) has no other effect.
 */
export const recordApprovalVote = internalMutation({
	args: {
		approvalToken: v.string(),
		slackUserId: v.string(),
		decision: v.union(v.literal('approve'), v.literal('reject')),
		votedAt: v.number(),
	},
	handler: async (
		ctx,
		args
	): Promise<{ recorded: boolean; status: SlackApprovalStatus | 'unknown' }> => {
		const request = await ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_token', (q) => q.eq('approvalToken', args.approvalToken))
			.unique();
		// Unknown token: reveal nothing, record nothing.
		if (!request) return { recorded: false, status: 'unknown' };

		const incoming: SlackApprovalVote = {
			slackUserId: args.slackUserId,
			decision: args.decision,
			votedAt: args.votedAt,
		};
		const toAppend = voteToRecord(request.votes, incoming);
		if (toAppend === null) {
			// Duplicate / replay: idempotent no-op.
			return { recorded: false, status: deriveApprovalStatus(request, args.votedAt) };
		}
		const votes = [...request.votes, toAppend];
		await ctx.db.patch(request._id, { votes });
		return { recorded: true, status: deriveApprovalStatus({ ...request, votes }, args.votedAt) };
	},
});

/** Record the outcome of the outbound Slack notification attempt. */
export const setNotifyOutcome = internalMutation({
	args: {
		approvalToken: v.string(),
		outcome: v.union(v.literal('sent'), v.literal('failed'), v.literal('skipped')),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<void> => {
		const request = await ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_token', (q) => q.eq('approvalToken', args.approvalToken))
			.unique();
		if (!request) return;
		await ctx.db.patch(request._id, {
			notifyStatus: args.outcome,
			notifyAttempts: request.notifyAttempts + 1,
			...(args.error ? { notifyError: args.error.slice(0, 300) } : {}),
		});
	},
});

/**
 * Read-only status of the hold record for a message — used by tests and any
 * introspection UI. Never mutates and never sends.
 */
export const getHoldStatus = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (
		ctx,
		args
	): Promise<{ exists: boolean; status: SlackApprovalStatus | 'none' }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const request = await ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_org_and_message', (q) =>
				q.eq('organizationId', organizationId).eq('inboundMessageId', args.inboundMessageId)
			)
			.unique();
		if (!request) return { exists: false, status: 'none' };
		return { exists: true, status: deriveApprovalStatus(request, Date.now()) };
	},
});
