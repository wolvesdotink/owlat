import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import { isSuppressed } from '../lib/suppression';
import { selectedSendProviderReady } from '../lib/sendProviders/capability';

/**
 * Error thrown by `enqueueNonCampaignSend` when the recipient is on the
 * suppression list (`blockedEmails`). Callers (the automation email step and
 * the agent approved-reply action) catch this and translate it into a
 * non-sent terminal outcome instead of producing a Send row. Exported as a
 * stable string so call sites can recognize the suppression case specifically
 * rather than treating it as a transient failure.
 */
export const RECIPIENT_BLOCKED_ERROR = 'recipient_blocked';

/**
 * Error thrown by `enqueueNonCampaignSend` when no delivery provider is
 * configured for the instance. Automation steps and agent replies dispatch
 * through the composed provider abstraction (transactional pool → transport); with
 * no provider there is nothing to send through, so we throw before writing a
 * `transactionalSends` row that could never deliver. Callers translate this
 * into a failed (not retried-forever) terminal outcome.
 */
export const NO_DELIVERY_PROVIDER_ERROR = 'no_delivery_provider';

// Per ADR-0006, the workpool `onComplete` callback is owned by the Send
// completion (module) at `delivery/sendCompletion.ts` — each enqueue below
// wires it directly via `internal.delivery.sendCompletion.completeSend`. The
// legacy `onEmailComplete` that previously lived in this file (per-kind
// branching, inline `transactionalSends.createInternal` on success, inline
// contact-activity insert, attachment-cleanup loop, provider health tracking)
// is gone; every concern moved to the lifecycle effect list or to the Send
// completion module.

/**
 * Internal mutation to enqueue campaign emails to workpool (used for
 * timezone-delayed sending). Lives in a non-node file because mutations
 * cannot run in Node.js runtime.
 *
 * Each enqueue carries a typed `sendRef` in the workpool context so the
 * Send completion module can translate worker outcomes into Send lifecycle
 * transitions uniformly across kinds.
 */
export const enqueueCampaignEmails = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		emails: v.array(
			v.object({
				emailSendId: v.id('emailSends'),
				contactId: v.id('contacts'),
				email: v.string(),
				firstName: v.optional(v.string()),
				lastName: v.optional(v.string()),
			})
		),
		from: v.string(),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		htmlContent: v.string(),
		convexSiteUrl: v.optional(v.string()),
		siteUrl: v.optional(v.string()),
		audienceType: v.optional(v.union(v.literal('topic'), v.literal('segment'))),
		viewInBrowserUrl: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		trackingBaseUrl: v.optional(v.string()),
		// Singleton org id — anchors the Gmail FBL Feedback-ID SenderId.
		organizationId: v.optional(v.string()),
		// RFC 2919 List-Id header value for a TOPIC campaign, pre-built by the
		// orchestrator via `getListIdHeader`. Absent for segment campaigns.
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		for (const recipient of args.emails) {
			await campaignEmailPool.enqueueAction(
				ctx,
				internal.delivery.worker.sendSingleEmail,
				{
					envelopeInput: {
						kind: 'campaign' as const,
						to: recipient.email,
						from: args.from,
						replyTo: args.replyTo,
						providerType: args.providerType,
						ipPool: args.ipPool,
						template: {
							subject: args.subject,
							htmlContent: args.htmlContent,
						},
						contactInfo: {
							contactId: recipient.contactId,
							email: recipient.email,
							firstName: recipient.firstName,
							lastName: recipient.lastName,
						},
						audienceType: args.audienceType,
						emailSendId: recipient.emailSendId,
						campaignId: args.campaignId,
						organizationId: args.organizationId,
						siteUrl: args.siteUrl,
						convexSiteUrl: args.convexSiteUrl,
						trackingBaseUrl: args.trackingBaseUrl,
						viewInBrowserUrl: args.viewInBrowserUrl,
						listId: args.listId,
					},
				},
				{
					onComplete: internal.delivery.sendCompletion.completeSend,
					context: {
						sendRef: {
							kind: 'campaign' as const,
							id: recipient.emailSendId,
						},
					},
				}
			);
		}

		return { enqueued: args.emails.length };
	},
});

/**
 * Shared writer for the three NON-campaign, non-template-API Send sources:
 * automation email steps and agent approved-replies (and, in principle, any
 * future 1:1 producer). Inserts a `transactionalSends` row in `queued` with the
 * caller's provenance, then enqueues `sendSingleEmail` on the transactional pool
 * with the same `onComplete` + `sendRef` wiring as `transactional/dispatch.ts`,
 * so the worker outcome flows through the Send lifecycle — and a hard bounce
 * inserts a blocklist row and increments the `sendingReputation` denominator,
 * which the old direct-dispatch path silently skipped.
 *
 * This is the single suppression chokepoint for both non-campaign producers:
 * before inserting the Send row it checks `blockedEmails` (matching the
 * transactional intake at `transactional/dispatch.ts`) and THROWS
 * `recipient_blocked` for a hard-bounced / complained / manually-blocked
 * address. No row is written, so a suppressed recipient never receives
 * automation or agent mail (Gmail/Yahoo 2024 sender requirements + CAN-SPAM
 * §316.5 honor-suppression). Callers catch this and finish in a non-sent
 * terminal state.
 *
 * The subject + html are PRE-RENDERED by the caller (automation personalizes
 * against the contact; agent escapes its draft). They are passed straight to
 * the transactional envelope with NO `dataVariables`, so the transactional
 * composer's re-personalization is a no-op on already-substituted text.
 */
export const enqueueNonCampaignSend = internalMutation({
	args: {
		kind: v.union(v.literal('automation'), v.literal('agent_reply')),
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
		automationId: v.optional(v.id('automations')),
		inboundMessageId: v.optional(v.id('inboundMessages')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
		subject: v.string(),
		html: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		headers: v.optional(v.record(v.string(), v.string())),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		// Marketing List-Unsubscribe wiring (automation steps only): when set, the
		// worker builds the RFC 8058 one-click header from `contactId` +
		// `convexSiteUrl`. Agent 1:1 replies leave it unset (no List-Unsubscribe
		// on 1:1 mail) but DO carry the RFC 3834 Auto-Submitted anti-loop header
		// stamped by the transactional composer (see below).
		listUnsubscribe: v.optional(v.boolean()),
		convexSiteUrl: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Delivery-provider gate, matched to the worker's provider selection: an
		// explicit `providerType` is authoritative, and EMAIL_PROVIDER is consulted
		// only when it is absent. THROW before the row insert (fail-closed) rather
		// than queue a doomed `transactionalSends` row.
		// External-mailbox 1:1 replies use the user's own SMTP via a different path
		// and never reach this producer.
		if (!(await selectedSendProviderReady(ctx, args.providerType))) {
			throw new Error(NO_DELIVERY_PROVIDER_ERROR);
		}

		// Suppression gate. A recipient on the blocklist (hard bounce / spam
		// complaint / manual block) must never be sent automation or agent mail.
		// The shared `isSuppressed` owns the normalization + `by_email` point
		// read; this path's POLICY is to THROW before the row insert, so no
		// `transactionalSends` row is produced for a suppressed address.
		if (await isSuppressed(ctx, args.email)) {
			throw new Error(RECIPIENT_BLOCKED_ERROR);
		}

		const sendId = await ctx.db.insert('transactionalSends', {
			kind: args.kind,
			email: args.email,
			status: 'queued',
			queuedAt: Date.now(),
			subject: args.subject,
			...(args.contactId ? { contactId: args.contactId } : {}),
			...(args.automationId ? { automationId: args.automationId } : {}),
			...(args.inboundMessageId ? { inboundMessageId: args.inboundMessageId } : {}),
			...(args.transactionalEmailId ? { transactionalEmailId: args.transactionalEmailId } : {}),
			...(args.providerType ? { providerType: args.providerType } : {}),
		});

		// Gmail FBL — singleton org id anchors the stable `txn`-stream
		// Feedback-ID SenderId for automation + agent-reply sends.
		const organizationId = await ctx.runQuery(
			internal.campaigns.sendQueries.getSingletonOrganizationId,
			{}
		);

		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{
				envelopeInput: {
					kind: 'transactional' as const,
					messageType:
						args.kind === 'automation' ? ('automation' as const) : ('transactional' as const),
					emailPurpose:
						args.kind === 'automation' ? ('marketing' as const) : ('transactional' as const),
					to: args.email,
					from: args.from,
					replyTo: args.replyTo,
					providerType: args.providerType,
					ipPool: args.ipPool,
					sendId,
					template: {
						subject: args.subject,
						htmlContent: args.html,
					},
					// RFC 3834: an agent 1:1 reply IS an automatic reply to a
					// specific inbound message, so it stamps
					// `Auto-Submitted: auto-replied`. Automation steps are not a
					// reply to a message → they keep the composer's default
					// `auto-generated`. Both values are `!= no`, so isAutomatedMail
					// classifies either as automated and the message stays loop-safe.
					...(args.kind === 'agent_reply' ? { autoSubmittedType: 'auto-replied' as const } : {}),
					...(organizationId ? { organizationId } : {}),
					...(args.headers ? { headers: args.headers } : {}),
					...(args.contactId ? { contactId: args.contactId } : {}),
					...(args.listUnsubscribe ? { listUnsubscribe: args.listUnsubscribe } : {}),
					...(args.convexSiteUrl ? { convexSiteUrl: args.convexSiteUrl } : {}),
				},
			},
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: {
					sendRef: { kind: 'transactional' as const, id: sendId },
				},
			}
		);

		return { sendId };
	},
});
