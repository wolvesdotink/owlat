/**
 * Inbound Email Receiver
 *
 * Receives inbound emails from the MTA webhook, stores them in the
 * inboundMessages table, resolves conversation threading, and links
 * to existing contacts (or creates new ones).
 *
 * Threading strategy (RFC 5322):
 * 1. Primary: In-Reply-To header → find existing message by messageId
 * 2. Secondary: References header �� find any referenced message
 * 3. Fallback: Contact email + normalized subject matching
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { createContact } from '../contacts/creation';
import { recordContactActivity } from '../contactActivities/writer';
import { findOrCreateForEmail } from './threads/module';
import { applyInboxStatsDelta } from '../lib/inboxStats';
import { isFeatureEnabled } from '../lib/featureFlags';
import { recordInboundMirror } from '../unifiedMessages';
import { logError, logInfo } from '../lib/runtimeLog';
import { rateLimiter } from '../rateLimiter';
import { extractEmail, normalizeSubject } from '../lib/emailAddress';
import { isAutomatedMail } from '../lib/inboundClassification';
import { isSuppressed } from '../lib/suppression';

// Re-exported for existing importers of this module.
export { extractEmail, normalizeSubject };

/**
 * Receive an inbound email from the MTA webhook.
 *
 * This mutation:
 * 1. Resolves or creates a conversation thread
 * 2. Links to an existing contact or creates a new one
 * 3. Stores the message in inboundMessages
 * 4. Schedules the agent pipeline security scan
 */
export const receiveMessage = internalMutation({
	args: {
		from: v.string(),
		to: v.string(),
		subject: v.string(),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		headers: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		attachmentMeta: v.optional(v.string()),
		timestamp: v.number(),
	},
	handler: async (ctx, args) => {
		const senderEmail = extractEmail(args.from);
		const normalizedSubj = normalizeSubject(args.subject);
		const now = Date.now();

		// ── 1. Resolve contact ──
		const { contactId } = await createContact(ctx, {
			channel: 'email',
			identifier: senderEmail,
			source: 'inbound',
			mode: 'upsert',
			contactFields: { firstName: extractNameFromEmail(args.from) },
		});

		// ── 2. Resolve or create conversation thread ──
		// The Conversation thread module owns the three-strategy cascade
		// (In-Reply-To → References → normalized-subject) plus the atomic
		// messageCount / lastMessageAt maintenance and reopen-if-closed.
		const { threadId } = await findOrCreateForEmail(ctx, {
			contactId,
			contactIdentifier: senderEmail,
			subject: args.subject,
			normalizedSubject: normalizedSubj,
			inReplyTo: args.inReplyTo,
			references: args.references,
			occurredAt: now,
		});

		// ── 3. Store the inbound message ──
		const inboundMessageId = await ctx.db.insert('inboundMessages', {
			messageId: args.messageId,
			from: args.from,
			to: args.to,
			subject: args.subject,
			textBody: args.textBody,
			htmlBody: args.htmlBody,
			inReplyTo: args.inReplyTo,
			references: args.references,
			headers: args.headers,
			attachmentMeta: args.attachmentMeta,
			threadId,
			contactId,
			processingStatus: 'received',
			receivedAt: args.timestamp,
		});
		await applyInboxStatsDelta(ctx, null, 'received');

		// ── Capture post-send OUTCOME signal (graduated-autonomy learning) ──
		// If this inbound message is a REPLY on a thread whose prior message the
		// agent AUTO-sent, the reply's sentiment is a real-world calibration
		// signal — otherwise the self-tuning loop only ever learns from the
		// shrinking human-reviewed subset (see agent/outcomeFeedback.ts). Cheap
		// tier + fail-soft: scheduled out-of-band so it can never block or fail
		// ingest, gated to actual replies, and re-verified as auto-sent inside
		// the action before anything is recorded.
		const isReply = Boolean(args.inReplyTo || args.references);
		const replyText = args.textBody ?? args.htmlBody;
		if (isReply && replyText && (await isFeatureEnabled(ctx, 'ai.agent'))) {
			try {
				await ctx.scheduler.runAfter(
					0,
					internal.agent.outcomeFeedback.classifyReplyOutcome,
					{ replyMessageId: inboundMessageId, replyText },
				);
			} catch (err) {
				logError('[Inbound Email] Failed to schedule reply-outcome classification:', err);
			}
		}

		// ── Mirror into the unified contact timeline ──
		// Inbound email is a genuine cross-channel CONVERSATION: it has a real
		// conversationThread and the per-contact UnifiedTimelineTab interleaves it
		// with SMS/WhatsApp/chat rows. Mirror it alongside the channel writer in
		// webhooks/channels.ts:processInboundChannel. Idempotent on the SMTP
		// Message-ID (re-delivery), and best-effort: a mirror failure must never
		// fail receiveMessage / make the MTA retry a message we already stored.
		//
		// BOUNDARY: only conversational email is mirrored. Campaign /
		// transactional / automation OUTBOUND sends are not conversations — they
		// have no inbound thread, would force invented threadIds, and would
		// re-introduce a per-send write into unifiedMessages. They already surface
		// in the Activity tab via contactActivities. Do NOT mirror them here; the
		// only outbound email that belongs in unifiedMessages is a threaded agent
		// reply (see delivery/sendCompletion.ts).
		try {
			await recordInboundMirror(ctx, {
				threadId,
				channel: 'email',
				contactId,
				content: JSON.stringify({
					text: args.textBody,
					html: args.htmlBody,
					subject: args.subject,
				}),
				externalMessageId: args.messageId,
			});
		} catch (err) {
			logError('[Inbound Email] Failed to mirror into unified timeline:', err);
		}

		// Log inbound activity on the contact
		await recordContactActivity(ctx, {
			literal: 'inbound_received',
			contactId,
			metadata: {
				emailSubject: args.subject,
			},
			occurredAt: now,
		});

		// ── Blocklist / suppression auto-archive ──
		// A sender on the CAN-SPAM / honor-suppression blocklist (`blockedEmails`)
		// has been hard-blocked (spam complaint, hard bounce, or a manual
		// `blockSender` on a prior message). We must NOT drop the mail — the
		// inbound path has a hard never-drop invariant (SMTP 5xx rejection is not
		// an option here) — so store-but-skip: the message is already persisted
		// above, and we archive it via the same lifecycle edge `blockSender` uses
		// (`received → archived`, reason `sender_blocked`) and skip the entire AI
		// classify/route pipeline. This mirrors the store-but-skip shape of the
		// auto-responder and rate-cap branches below.
		if (await isSuppressed(ctx, senderEmail)) {
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId,
				input: {
					to: 'archived',
					at: now,
					reason: 'sender_blocked',
				},
			});
			logInfo(
				'[Inbound Email] blocklisted sender mail stored and archived without AI processing',
				{ contactId, threadId, from: args.from },
			);
			return { inboundMessageId, threadId, contactId };
		}

		// ── Mail-loop / auto-responder suppression ──
		// The AI inbox address is public, so vacation autoresponders, mailing-list
		// blasts, and forged self-sends would otherwise each trigger a full
		// guard+classify+capable-draft+extract pipeline run — and an auto-reply to
		// an auto-responder forms a loop. The Postbox vacation/forwarding path
		// already drops these via the same RFC 3834 check (mail/deliveryHooks.ts);
		// apply it here BEFORE spending any model budget. Store-but-skip, the same
		// shape as the rate-limit cap below.
		const suppressed =
			isAutomatedMail(parseHeaders(args.headers)) || senderEmail === extractEmail(args.to);

		// ── 4. Schedule the agent pipeline (Agent walker starts at security_scan) ──
		// When coalescing is enabled (agentConfig.coalesceWindowMs > 0), bursts
		// on the same thread are debounced into a single pipeline run; the
		// coalesce batch starts the walker for the leader once the window
		// settles. Otherwise, start immediately.
		let deferred = false;
		if (!suppressed && (await isFeatureEnabled(ctx, 'ai.agent'))) {
			const config = await ctx.db.query('agentConfig').first();
			const windowMs = config?.coalesceWindowMs ?? 0;
			if (windowMs > 0) {
				const { shouldDefer } = await ctx.runMutation(
					internal.agent.coalescing.shouldCoalesce,
					{ threadId, messageId: inboundMessageId, coalesceWindowMs: windowMs },
				);
				deferred = shouldDefer;
			}
		}

		if (suppressed) {
			logInfo(
				'[Inbound Email] automated/self-send mail stored without AI processing',
				{ contactId, threadId, from: args.from },
			);
		} else if (!deferred) {
			// Cost cap: each pipeline run spends multiple LLM calls (guard +
			// classify + capable-tier draft + extract). Inbound email volume is
			// attacker-controlled (the AI inbox address is public, and distinct
			// threads defeat coalescing), so gate the START on a per-sender AND a
			// global rate limit. Over the cap we keep the stored message but skip
			// the expensive pipeline — bounding model-cost / quota exhaustion from
			// a flood while never dropping mail.
			const perSender = await rateLimiter.limit(ctx, 'agentPipelinePerSender', {
				key: contactId,
			});
			const globalOk = perSender.ok
				? (await rateLimiter.limit(ctx, 'agentPipelineGlobal', { key: 'global' })).ok
				: false;
			if (perSender.ok && globalOk) {
				await ctx.scheduler.runAfter(0, internal.agent.walker.start, {
					inboundMessageId,
				});
			} else {
				logError(
					'[Inbound Email] Agent pipeline cost cap hit — message stored without AI processing',
					{ contactId, threadId },
				);
			}
		}

		return { inboundMessageId, threadId, contactId };
	},
});

/**
 * Parse the serialized inbound header map (a JSON string of header→value, see
 * webhooks/dispatcher.ts) defensively. A malformed blob must never fail the
 * receive — we just treat it as no headers.
 */
function parseHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
	} catch {
		// Not valid JSON — fall through to the empty-headers default.
	}
	return {};
}

/**
 * Extract a first name from the "Name <email>" format
 */
export function extractNameFromEmail(fromField: string): string | undefined {
	// Try "First Last <email>" format
	const nameMatch = fromField.match(/^([^<]+)</);
	if (nameMatch?.[1]) {
		const fullName = nameMatch[1].trim().replace(/"/g, '');
		if (fullName) {
			return fullName.split(/\s+/)[0]; // Return first name
		}
	}
	return undefined;
}
