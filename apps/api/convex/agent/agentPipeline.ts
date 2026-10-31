/**
 * Agent Pipeline Orchestrator
 *
 * Shared mutations and queries used by all pipeline steps.
 * Handles action tracking, message status updates, and helper operations.
 */

import { v } from 'convex/values';
import { internalQuery, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getOptional } from '../lib/env';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import { logError, logInfo } from '../lib/runtimeLog';
import type { AgentReplyIntakeOutcome } from '../inbox/replyAttachments';
import { planEmailReply, routeApprovedReply, settleIntakeOutcome } from './approvedReplyDecision';

// ============================================================
// Helper Queries
// ============================================================

/**
 * Get an inbound message by ID
 */
export const getMessage = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.inboundMessageId);
	},
});

/**
 * Get a contact by ID
 */
export const getContact = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.contactId);
	},
});

/**
 * Get recent activities for a contact
 */
export const getRecentActivities = internalQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.take(args.limit);
	},
});

/**
 * Get recent messages in a thread
 */
export const getThreadMessages = internalQuery({
	args: {
		threadId: v.id('conversationThreads'),
		limit: v.number(),
		excludeMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.take(args.limit + 1); // Take one extra in case we need to exclude

		return messages.filter((m) => m._id !== args.excludeMessageId).slice(0, args.limit);
	},
});

/**
 * Check if the agent pipeline is enabled. Gated on the `ai.agent` feature flag
 * (with its dependency cascade), not on `agentConfig` — that table now holds
 * only operational tuning fields (threshold, tone, signature).
 */
export const isAgentEnabled = internalQuery({
	args: {},
	handler: async (ctx) => isFeatureEnabled(ctx, 'ai.agent'),
});

/**
 * Get agent config (singleton)
 */
export const getAgentConfig = internalQuery({
	args: {},
	handler: async (ctx) => {
		const configs = await ctx.db.query('agentConfig').take(1);
		return configs.length > 0 ? configs[0] : null;
	},
});

// ============================================================
// Action / Status mutations
// ============================================================
//
// All writes of `inboundMessages.processingStatus`,
// `agentActions`, and `conversationThreads.latestDraftStatus` are owned
// by `inbox/processingLifecycle.ts`. The helpers that previously lived
// here (updateMessageStatus / quarantineMessage / archiveMessage /
// updateSecurityFlags / storeClassification / storeDraft /
// updateContextTier / updateThreadDraftStatus / createAction /
// completeAction / failAction / incrementAutoReplyCount /
// retryFailedActions) have all moved to the lifecycle module.

/**
 * Send an approved agent-drafted reply to the customer who sent the inbound
 * message by enqueuing a `kind: 'agent_reply'` Send. On a pre-flight failure
 * (no draft, unparseable recipient, missing sender identity) the inbound message
 * transitions to `failed` immediately. Otherwise the reply is ENQUEUED and the
 * inbound message's `sent` / `failed` transition is driven later by the Send
 * completion module once the worker outcome lands — so the reply flows through
 * the same Send lifecycle as every other outbound (provider health, the
 * sendingReputation denominator, blocklist-on-hard-bounce).
 *
 * Scope: the agent shared inbox is the EMAIL pipeline (`inbound.received` →
 * `inboundMessages`). Non-email customer channels (sms/whatsapp/generic) land
 * in `unifiedMessages` via a separate path and never reach this action; the
 * recipient is still validated so a non-email recipient can never be faked as
 * `sent`.
 *
 * The decisions live in `./approvedReplyDecision.ts`; this action loads, asks
 * them, and writes.
 */
export const sendApprovedReply = internalAction({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		// True when the approval was autonomous (route step `source: 'auto'`).
		// The deterministic pre-send reference monitor runs ONLY on this path;
		// human-reviewed approvals (`autonomous: false`/absent) send unchanged.
		autonomous: v.optional(v.boolean()),
		// How many times this send already waited for a file answer's copy.
		attachmentWaits: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const autonomous = args.autonomous === true;
		const attachmentWaits = args.attachmentWaits ?? 0;
		const fail = async (errorMessage: string): Promise<void> => {
			logError(`[Agent Pipeline] sendApprovedReply failed: ${errorMessage}`);
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: args.inboundMessageId,
				input: { to: 'failed', at: Date.now(), errorMessage },
			});
		};

		// Send-fire is the moment a HUMAN approve becomes a real send: record the
		// graduated-autonomy learning signals HERE, not at approve time, so an
		// approve undone inside its undo window trains nothing and a re-approve
		// records exactly once (the mutation is idempotent per message — the
		// stuck-approved reconcile may legitimately re-fire this action).
		// Best-effort: learning-loop bookkeeping must never fail — or duplicate —
		// an already-dispatched send. Autonomous sends never record it; their
		// feedback comes from real-world outcome signals (agent/outcomeFeedback).
		const recordHumanApprovalFeedback = async (): Promise<void> => {
			if (autonomous) return;
			try {
				await ctx.runMutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
					inboundMessageId: args.inboundMessageId,
				});
			} catch (err) {
				logError(
					`[Agent Pipeline] approval feedback recording failed: ${
						err instanceof Error ? err.message : String(err)
					}`
				);
			}
		};

		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		if (!message) {
			logError('[Agent Pipeline] sendApprovedReply: message not found', args.inboundMessageId);
			return;
		}
		const route = routeApprovedReply(message, attachmentWaits);
		if (route.kind === 'stop') return;
		if (route.kind === 'fail') return await fail(route.errorMessage);

		// The channel adapter is fail-safe and, with no sendCompletion module for
		// channels, drives THIS message to sent/failed off the real send outcome.
		// It is a `'use node'` action, so it is scheduled (keeps the fail-safe
		// boundary).
		if (route.kind === 'channel') {
			await ctx.scheduler.runAfter(0, internal.channels.outbound.dispatchOutbound, {
				...route.dispatch,
				inboundMessageId: args.inboundMessageId,
			});
			logInfo(
				`[Agent Pipeline] Dispatched approved ${route.dispatch.channel} reply (inbound=${args.inboundMessageId})`
			);
			await recordHumanApprovalFeedback();
			return;
		}

		// The org sending identity mirrors the automation email step.
		const settings = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getInstanceSettings,
			{}
		);
		const plan = planEmailReply(
			message,
			route,
			{
				fromEmail: settings?.defaultFromEmail ?? getOptional('DEFAULT_FROM_EMAIL'),
				fromName: settings?.defaultFromName ?? getOptional('DEFAULT_FROM_NAME'),
			},
			autonomous
		);
		if (plan.kind === 'fail') return await fail(plan.errorMessage);

		// The Non-campaign send intake runs the shared gate sequence (abuse →
		// provider-ready → suppression), resolves the provider route in its own
		// transaction and, when nothing refuses, inserts the `agent_reply` Send
		// and enqueues it. Through the Team inbox reply attachments: the files a
		// person attached in the thread composer go out with the reply (never the
		// agent's unconfirmed `attachmentSuggestions`); an autonomous send only
		// takes files attached after the message arrived.
		let outcome: AgentReplyIntakeOutcome;
		try {
			// checkpoint: the intake is the send itself; once it enqueued, the Send completion owns this message, and a refusal it returned is filed below or re-fired by the stuck-approved reconcile
			outcome = await ctx.runMutation(internal.inbox.replyAttachments.intakeAgentReply, {
				...plan.envelope,
				autonomous,
				inboundMessageId: args.inboundMessageId,
			});
		} catch (err) {
			// Every REFUSAL is a typed `{ ok: false }` return, so a throw here is an
			// infrastructure fault, never a policy decision.
			return await fail(err instanceof Error ? err.message : String(err));
		}

		const settled = settleIntakeOutcome(outcome, attachmentWaits);
		switch (settled.kind) {
			case 'hold':
				await ctx.runMutation(internal.inbox.processingLifecycle.holdSend, {
					inboundMessageId: args.inboundMessageId,
					autonomous,
					attachmentWaits: settled.attachmentWaits,
					delayMs: settled.delayMs,
				});
				return;
			case 'fail':
				return await fail(settled.errorMessage);
			case 'archive':
				logInfo(
					`[Agent Pipeline] approved reply withheld (${settled.refusal}); archiving inbound message`,
					args.inboundMessageId
				);
				await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
					inboundMessageId: args.inboundMessageId,
					input: { to: 'archived', at: Date.now(), reason: settled.reason },
				});
				return;
			case 'enqueued':
				logInfo(
					`[Agent Pipeline] Enqueued approved reply to ${redactEmailAddress(route.recipient)} (sendId=${settled.sendId})`
				);
				await recordHumanApprovalFeedback();
		}
	},
});

// Cron-driven retry of failed agentActions — moved to
// `inbox/processingLifecycle.ts:retryFailedActions`.
