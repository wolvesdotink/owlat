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
import { isValidEmail } from '../lib/inputGuards';
import { getOptional } from '../lib/env';
import { buildReplySubject } from '../lib/emailAddress';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { parseAddress } from '@owlat/shared';
import { logError, logInfo } from '../lib/runtimeLog';
import { isOutboundChannel } from '../lib/convexValidators';
import { runReferenceMonitor } from './referenceMonitor';

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
// Per ADR-0010, all writes of `inboundMessages.processingStatus`,
// `agentActions`, and `conversationThreads.latestDraftStatus` are owned
// by `inbox/processingLifecycle.ts`. The helpers that previously lived
// here (updateMessageStatus / quarantineMessage / archiveMessage /
// updateSecurityFlags / storeClassification / storeDraft /
// updateContextTier / updateThreadDraftStatus / createAction /
// completeAction / failAction / incrementAutoReplyCount /
// retryFailedActions) have all moved to the lifecycle module.

/**
 * Escape a plain-text draft body into a minimal HTML fragment. The agent's
 * `draftResponse` is final, non-templated text (the signature is already
 * folded in by the `draft` step), so we escape it and convert newlines to
 * `<br>` rather than running it through the block renderer.
 */
function draftToHtml(text: string): string {
	// escapeHtmlWithBreaks escapes all five HTML metacharacters (the old inline
	// version omitted the apostrophe) and converts newlines to <br>.
	return `<div>${escapeHtmlWithBreaks(text.replace(/\r\n/g, '\n'))}</div>`;
}

/**
 * Build the RFC 5322 threading headers for a reply. `In-Reply-To` points at
 * the inbound message's own `Message-ID`; `References` appends it to the
 * original chain so clients thread the reply under the customer's message.
 * Message-IDs are wrapped in angle brackets if the provider stored them bare.
 */
function buildThreadingHeaders(inbound: {
	messageId?: string;
	references?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!inbound.messageId) return headers;
	const wrapped = inbound.messageId.startsWith('<') ? inbound.messageId : `<${inbound.messageId}>`;
	headers['In-Reply-To'] = wrapped;
	const prior = (inbound.references ?? '').trim();
	headers['References'] = prior ? `${prior} ${wrapped}` : wrapped;
	return headers;
}

/**
 * Send an approved agent-drafted reply to the customer who sent the inbound
 * message by enqueuing a `kind: 'agent_reply'` Send. On a pre-flight failure
 * (no draft, unparseable recipient, missing sender identity) the inbound message
 * transitions to `failed` immediately. Otherwise the reply is ENQUEUED and the
 * inbound message's `sent` / `failed` transition is driven later by the Send
 * completion module once the worker outcome lands — so the reply now flows
 * through the same Send lifecycle as every other outbound (provider health, the
 * sendingReputation denominator, blocklist-on-hard-bounce), which the old
 * direct-dispatch path silently skipped.
 *
 * Scope: the agent shared inbox is the EMAIL pipeline (`inbound.received` →
 * `inboundMessages`). Non-email customer channels (sms/whatsapp/generic) land
 * in `unifiedMessages` via a separate path and never reach this action; we
 * still guard the recipient with `isValidEmail` and fail gracefully so a
 * non-email recipient can never be faked as `sent`.
 */
export const sendApprovedReply = internalAction({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		// True when the approval was autonomous (route step `source: 'auto'`).
		// The deterministic pre-send reference monitor runs ONLY on this path;
		// human-reviewed approvals (`autonomous: false`/absent) send unchanged.
		autonomous: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const fail = async (errorMessage: string): Promise<void> => {
			logError(`[Agent Pipeline] sendApprovedReply failed: ${errorMessage}`);
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: args.inboundMessageId,
				input: { to: 'failed', at: Date.now(), errorMessage },
			});
		};

		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});

		if (!message) {
			logError('[Agent Pipeline] sendApprovedReply: message not found', args.inboundMessageId);
			return;
		}
		if (!message.draftResponse) {
			await fail('No draft to send');
			return;
		}

		// Non-email channels (sms/whatsapp/generic) dispatch through the channel
		// adapter instead of the MTA email pipeline. dispatchOutbound is fail-safe
		// and — because channels have no sendCompletion module — drives THIS message
		// to sent/failed off the real send outcome (we pass inboundMessageId). It is
		// a `'use node'` action, so schedule it (keeps the fail-safe boundary).
		if (isOutboundChannel(message.to)) {
			if (!message.threadId || !message.contactId) {
				await fail(`Channel reply (${message.to}) is missing its thread or contact`);
				return;
			}
			await ctx.scheduler.runAfter(0, internal.channels.outbound.dispatchOutbound, {
				channel: message.to,
				contactId: message.contactId,
				threadId: message.threadId,
				content: {
					text: message.draftResponse,
					...(message.draftSubject ? { subject: message.draftSubject } : {}),
				},
				inboundMessageId: args.inboundMessageId,
			});
			logInfo(
				`[Agent Pipeline] Dispatched approved ${message.to} reply (inbound=${args.inboundMessageId})`
			);
			return;
		}

		// Resolve the recipient. The inbound `from` is "Name <email>"; the reply
		// goes back to that address. A recipient that doesn't parse as a valid
		// email (e.g. a non-email channel that somehow reached here) fails rather
		// than being faked as sent.
		const recipient = extractRecipient(message.from);
		if (!recipient || !isValidEmail(recipient)) {
			await fail(`Unsupported or invalid reply recipient: "${message.from}"`);
			return;
		}

		// Resolve the org sending identity. Mirrors the automation email step:
		// instanceSettings.defaultFrom* → env defaults.
		const settings = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getInstanceSettings,
			{}
		);
		const fromEmail = settings?.defaultFromEmail ?? getOptional('DEFAULT_FROM_EMAIL');
		if (!fromEmail) {
			await fail(
				'No sending identity configured — set a default sender email in organization settings.'
			);
			return;
		}
		const fromName = settings?.defaultFromName ?? getOptional('DEFAULT_FROM_NAME');
		const from = formatFromAddress(fromEmail, fromName);

		// Reply subject: prefer the agent's draftSubject (already "Re: ..."),
		// otherwise derive one from the inbound subject.
		const subject =
			message.draftSubject ??
			(message.subject ? buildReplySubject(message.subject) : 'Re: your message');

		// RFC 5322 threading headers so the reply lands under the customer's
		// message in their client. Carried through the transactional envelope's
		// custom headers (the transactional composer emits none of its own).
		const headers = buildThreadingHeaders({
			messageId: message.messageId,
			references: message.references,
		});

		let html = draftToHtml(message.draftResponse);

		// Deterministic pre-send reference monitor — AUTONOMOUS path only. This is
		// the non-LLM data-isolation backstop that runs immediately before an
		// unattended send: it re-derives the authenticated recipient server-side and
		// asserts the resolved target matches it (no model-supplied / redirected /
		// forwarded recipient), runs a local DLP pass over the draft (credential /
		// OTP / recovery-link fingerprints), and strips remote images / tracking
		// pixels + off-allowlist link hosts from the outbound HTML. A recipient-lock
		// or DLP violation FAILS CLOSED — the unattended send is withheld (the draft
		// is preserved on the message; nothing is sent). The routine withhold path
		// is the `route` step's gate (→ human review); this backstop only trips on an
		// anomaly that slipped past it, and it never auto-sends on uncertainty.
		// Human-reviewed sends bypass the monitor entirely.
		if (args.autonomous) {
			const monitor = runReferenceMonitor({
				inboundFrom: message.from,
				resolvedRecipient: recipient,
				draftText: message.draftResponse,
				draftHtml: html,
				allowedLinkHosts: [fromEmail.slice(fromEmail.indexOf('@') + 1)],
			});
			if (!monitor.ok) {
				await fail(monitor.reason);
				return;
			}
			html = monitor.html;
		}

		// Enqueue the agent reply as a Send. The inbound message stays in
		// `approved` until the Send completion module drives it to `sent` / `failed`
		// (see delivery/sendCompletion.ts) — no more optimistic transition at
		// dispatch time.
		try {
			const route = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
				messageType: 'transactional',
				to: recipient,
				from,
			});
			if (!route) throw new Error('No delivery provider configured');
			const { sendId } = await ctx.runMutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
				kind: 'agent_reply',
				email: recipient,
				...(message.contactId ? { contactId: message.contactId } : {}),
				inboundMessageId: args.inboundMessageId,
				subject,
				html,
				from,
				providerType: route.providerType,
				ipPool: route.ipPool,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			});
			logInfo(`[Agent Pipeline] Enqueued approved reply to ${recipient} (sendId=${sendId})`);
		} catch (err) {
			await fail(err instanceof Error ? err.message : String(err));
		}
	},
});

/**
 * Extract the reply recipient address from an inbound `from` field. Handles
 * the "Name <email>" form and a bare address; returns undefined when nothing
 * address-shaped is present. Routed through the shared `parseAddress` so the
 * reply target agrees with inbound sender resolution / thread matching.
 */
function extractRecipient(fromField: string): string | undefined {
	return parseAddress(fromField)?.address;
}

// Cron-driven retry of failed agentActions — moved to
// `inbox/processingLifecycle.ts:retryFailedActions` per ADR-0010.
