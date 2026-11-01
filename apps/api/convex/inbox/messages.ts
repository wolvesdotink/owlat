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
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { createContact } from '../contacts/creation';
import { recordContactActivity } from '../contactActivities/writer';
import { findOrCreateForEmail } from './threads/module';
import { releaseClockIfNothingOwed } from './sla/threadClock';
import { applyInboxStatsDelta } from '../lib/inboxStats';
import { isFeatureEnabled } from '../lib/featureFlags';
import { recordInboundMirror } from '../channels/messages';
import { logError, logInfo, logWarn } from '../lib/runtimeLog';
import { redactEmailAddress, redactSubject } from '@owlat/shared/logRedaction';
import { rateLimiter } from '../lib/rateLimiter';
import { extractEmail, normalizeSubject } from '../lib/emailAddress';
import { isSuppressed } from '../lib/suppression';
import { inboundBodyColumns, inboundMirrorContent } from './bodyStorage';
import { attachmentIndexingValidator } from '../lib/literalValidators';
import {
	inboundMessageArgs,
	inboundReceiveResultValidator,
	type InboundReceiveResult,
} from './receiveInbound';
import { invalidateSenderMemoryOnAuthFailure } from '../decision/senderMemory';
import {
	coalesceWindowFor,
	decidePipelineStart,
	extractNameFromEmail,
	inboundMessageRow,
	planArrival,
} from './receiveDecision';

// Re-exported for existing importers of this module.
export { extractEmail, extractNameFromEmail, normalizeSubject };

/**
 * How many rows sharing one `Message-ID` the idempotency check will look at.
 *
 * Bounded because the header is sender-controlled: a sender that reuses one
 * value forever must not turn every delivery into an unbounded scan. Well above
 * any real collision count — mail that reuses a Message-ID reuses it a handful
 * of times, not thousands.
 */
const DUPLICATE_SCAN_LIMIT = 16;

/**
 * The stored row this delivery would duplicate, or `null`.
 *
 * ONE envelope test, called by both the transactional check inside
 * `receiveMessage` and the cheap pre-check `findIdByMessageId` the ingest
 * action runs first. They were two copies of the same query and the same
 * `.find`, kept in agreement by a comment — so the next person to tighten the
 * match (normalised addresses, say) would have tightened one of them and left
 * the pre-check skipping work the mutation would have stored.
 *
 * MATCHED ON THE ENVELOPE, not on the header alone. `Message-ID:` is free text
 * the sender chose, and some clients and ticketing systems reuse one across
 * genuinely different mail; a header-only match answers 200 and stores nothing,
 * which on a route with a never-drop invariant is the worst possible outcome.
 * A retry of the SAME delivery always repeats the same `from` and `to`, so
 * idempotency is unaffected.
 *
 * Without it a retried delivery inserts a second row, bumps the thread's
 * messageCount again, leaves another sealed `.eml` blob behind and charges the
 * attachment budget twice.
 *
 * Bounded by `DUPLICATE_SCAN_LIMIT` — see there for why.
 */
async function findStoredDuplicate(
	db: QueryCtx['db'],
	envelope: { messageId: string; from: string; to: string }
): Promise<Doc<'inboundMessages'> | null> {
	// Mail with no `Message-ID:` header at all would otherwise all collapse
	// onto one row.
	if (!envelope.messageId) return null;
	const sameId = await db
		.query('inboundMessages')
		.withIndex('by_message_id', (q) => q.eq('messageId', envelope.messageId))
		.take(DUPLICATE_SCAN_LIMIT);
	return sameId.find((row) => row.from === envelope.from && row.to === envelope.to) ?? null;
}

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
		// Everything that came off the wire — one spelling, shared with the
		// sealed-mail writer in `e2ee/open.decryptAndReceive`.
		...inboundMessageArgs,
		// Sealed Mail: mirrored unsealing flags from the decrypt-on-ingest
		// action on the AI-inbox path. `textBody`/`htmlBody` above are ALREADY the
		// decrypted plaintext when `sealed` is set (the action opened the message
		// before calling this mutation), so the agent pipeline + the unified mirror
		// consume real text. `isSignatureValid` is present only when we decrypted
		// and checked the signature — absent ⇒ undecryptable (no claim). All
		// optional so the plaintext path is byte-identical.
		isSealed: v.optional(v.boolean()),
		isSignatureValid: v.optional(v.boolean()),
		signerFingerprint: v.optional(v.string()),
		signerInstance: v.optional(v.string()),
		// F1: mirrored display fields of the inbound SIGNED-but-not-encrypted
		// PGP verdict, computed by e2ee/verifyInboundSignature on the dispatcher
		// path for clearsigned bodies. Distinct from the sealed mirror above —
		// signed plaintext makes no encryption claim. Both optional so every
		// existing caller (and plaintext mail) is byte-identical.
		isInboundSignatureValid: v.optional(v.boolean()),
		inboundSignerFingerprint: v.optional(v.string()),
		// The parts `receiveStoringLargeBodies` moved to sealed storage because
		// they would not fit the row. `textBody`/`htmlBody` still carry them in
		// full, for the projections derived below; they are not inlined.
		textBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyStorageId: v.optional(v.id('_storage')),
	},
	// One spelling of the result, shared with the sealed-mail writer in
	// `e2ee/open.decryptAndReceive`: a stored message always has a thread and a
	// contact, a duplicate hands back whatever the existing row holds.
	returns: inboundReceiveResultValidator,
	handler: async (ctx, args): Promise<InboundReceiveResult> => {
		// ── 0. Idempotency ──
		// The MTA retries a webhook it aborted after 10 s while the first attempt
		// may still be running, so a slow scan is delivered twice. Only here are
		// the check and the insert one transaction; `findStoredDuplicate` is the
		// envelope test the ingest action's cheap pre-check shares.
		const duplicate = await findStoredDuplicate(ctx.db, args);
		if (duplicate) {
			// WARN, not info: mail that arrived and was deliberately not stored,
			// logged with the redacted envelope so the decision can be found.
			logWarn('[Inbound Email] duplicate delivery — re-acknowledged, nothing stored', {
				messageId: args.messageId,
				from: redactEmailAddress(args.from),
				to: redactEmailAddress(args.to),
				subject: redactSubject(args.subject),
			});
			return {
				inboundMessageId: duplicate._id,
				threadId: duplicate.threadId,
				contactId: duplicate.contactId,
				isDuplicate: true,
			};
		}

		const plan = planArrival(args);
		const now = Date.now();

		// ── 1. Resolve contact ──
		const { contactId } = await createContact(ctx, {
			channel: 'email',
			identifier: plan.senderEmail,
			source: 'inbound',
			mode: 'upsert',
			contactFields: { firstName: plan.senderFirstName },
		});

		// ── 2. Resolve or create conversation thread ──
		// The Conversation thread module owns the three-strategy cascade
		// (In-Reply-To → References → normalized-subject) plus the atomic
		// messageCount / lastMessageAt maintenance and reopen-if-closed.
		const { threadId } = await findOrCreateForEmail(ctx, {
			contactId,
			contactIdentifier: plan.senderEmail,
			subject: args.subject,
			normalizedSubject: plan.normalizedSubject,
			inReplyTo: args.inReplyTo,
			references: args.references,
			occurredAt: now,
			preview: plan.preview,
		});

		// ── 3. Store the inbound message ──
		// E8b: seal the inline bodies at rest before they land in the row (the
		// preview derived above is sealed by the thread module too). A part the
		// ingest action already moved to storage is referenced, not inlined.
		// Readers go through lib/messageBodyInbound.ts for either shape.
		const bodyColumns = await inboundBodyColumns(args);
		const inboundMessageId = await ctx.db.insert(
			'inboundMessages',
			inboundMessageRow(args, { bodyColumns, threadId, contactId, isInfected: plan.isInfected })
		);
		await applyInboxStatsDelta(ctx, null, 'received');
		// A DMARC failure invalidates what is remembered about the sender.
		await invalidateSenderMemoryOnAuthFailure(
			ctx,
			{ scope: 'team_inbox' },
			args.from,
			args.dmarcResult
		);
		// A quarantined arrival needs no reply, but the thread write above started
		// a response clock for it (inbox/sla/clock.ts); it never passes through the
		// lifecycle edge that would stop it.
		if (plan.isInfected) await releaseClockIfNothingOwed(ctx, threadId, inboundMessageId);

		// ── Capture post-send OUTCOME signal (graduated-autonomy learning) ──
		// A reply on a thread whose prior message the agent AUTO-sent is a
		// real-world calibration signal (agent/outcomeFeedback.ts). Scheduled
		// out-of-band and fail-soft so it can never block or fail ingest; the
		// action re-verifies the auto-send before recording anything.
		if (plan.replyFeedbackText !== undefined && (await isFeatureEnabled(ctx, 'ai.agent'))) {
			try {
				await ctx.scheduler.runAfter(0, internal.agent.outcomeFeedback.classifyReplyOutcome, {
					replyMessageId: inboundMessageId,
					replyText: plan.replyFeedbackText,
				});
			} catch (err) {
				logError('[Inbound Email] Failed to schedule reply-outcome classification:', err);
			}
		}

		// ── Mirror into the unified contact timeline ──
		// Inbound email is a genuine cross-channel CONVERSATION, interleaved with
		// SMS/WhatsApp/chat rows on the contact's timeline, alongside the channel
		// writer in webhooks/channels.ts:processInboundChannel. Idempotent on the
		// SMTP Message-ID, and best-effort: a mirror failure must never fail the
		// receive or make the MTA retry a message we already stored. Only
		// conversational email is mirrored: campaign / transactional / automation
		// sends have no inbound thread and surface through contactActivities; the
		// one outbound email that belongs in unifiedMessages is a threaded agent
		// reply (delivery/sendCompletion.ts).
		try {
			await recordInboundMirror(ctx, {
				threadId,
				channel: 'email',
				contactId,
				// Bounded: a large message is mirrored as an excerpt plus the id of
				// this row, never as a second copy of the whole body.
				content: inboundMirrorContent(args, inboundMessageId),
				externalMessageId: args.messageId,
			});
		} catch (err) {
			logError('[Inbound Email] Failed to mirror into unified timeline:', err);
		}

		await recordContactActivity(ctx, {
			literal: 'inbound_received',
			contactId,
			metadata: { emailSubject: args.subject },
			occurredAt: now,
		});

		// ── Blocklist / suppression auto-archive ──
		// A hard-blocked sender (spam complaint, hard bounce, manual
		// `blockSender`) is stored-but-skipped, never dropped: archived through
		// the same lifecycle edge `blockSender` uses, with no AI pipeline. SCOPE
		// `'transactional'`: this is about senders we blocked, not bulk-mail
		// hygiene — a contact who stopped opening campaigns and writes to us is
		// engaging, and auto-archiving that reply would hide it.
		const logContext = { contactId, threadId, from: redactEmailAddress(args.from) };
		if (await isSuppressed(ctx, plan.senderEmail, { scope: 'transactional' })) {
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId,
				input: { to: 'archived', at: now, reason: 'sender_blocked' },
			});
			logInfo(
				'[Inbound Email] blocklisted sender mail stored and archived without AI processing',
				logContext
			);
			return { inboundMessageId, threadId, contactId, isDuplicate: false };
		}

		// ── 4. Schedule the agent pipeline (Agent walker starts at security_scan) ──
		// With a coalesce window, a burst on one thread is debounced into one run
		// that the coalesce batch starts for the leader once the window settles.
		let isCoalesced = false;
		if (!plan.isPipelineSkipped && (await isFeatureEnabled(ctx, 'ai.agent'))) {
			const config = await ctx.db.query('agentConfig').first();
			const windowMs = coalesceWindowFor(plan, config?.coalesceWindowMs);
			if (windowMs !== undefined) {
				const { shouldDefer } = await ctx.runMutation(internal.agent.coalescing.shouldCoalesce, {
					threadId,
					messageId: inboundMessageId,
					coalesceWindowMs: windowMs,
				});
				isCoalesced = shouldDefer;
			}
		}

		const start = decidePipelineStart(plan, isCoalesced);
		if (start.kind === 'skip') {
			logInfo(start.message, logContext);
		} else if (start.kind === 'start_within_caps') {
			const perSender = await rateLimiter.limit(ctx, 'agentPipelinePerSender', {
				key: contactId,
			});
			const isGlobalOk = perSender.ok
				? (await rateLimiter.limit(ctx, 'agentPipelineGlobal', { key: 'global' })).ok
				: false;
			if (perSender.ok && isGlobalOk) {
				await ctx.scheduler.runAfter(0, internal.agent.walker.start, { inboundMessageId });
			} else {
				logError(
					'[Inbound Email] Agent pipeline cost cap hit — message stored without AI processing',
					{ contactId, threadId }
				);
			}
		}

		return { inboundMessageId, threadId, contactId, isDuplicate: false };
	},
});

/**
 * Has this Message-ID already landed? The cheap half of the idempotency check
 * above, so the ingest action can bail before it seals a blob and spends up to
 * ten ClamAV round-trips re-scanning a message it already stored. The
 * authoritative check is still the transactional one inside `receiveMessage`;
 * this one only saves the work.
 */
export const findIdByMessageId = internalQuery({
	args: { messageId: v.string(), from: v.string(), to: v.string() },
	returns: v.union(v.id('inboundMessages'), v.null()),
	handler: async (ctx, args): Promise<Id<'inboundMessages'> | null> => {
		return (await findStoredDuplicate(ctx.db, args))?._id ?? null;
	},
});

/**
 * Record what attachment capture actually did with this message's files.
 *
 * Capture runs AFTER the row is inserted (delivery is never blocked by
 * enrichment), so the outcome has to be patched back. Without it a skipped
 * capture was invisible: the attachment listed and downloaded exactly like an
 * indexed one while the agent had never seen it, and the only trace was a
 * server log line nobody reading the thread can reach.
 */
export const setAttachmentIndexing = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		attachmentIndexing: attachmentIndexingValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			attachmentIndexing: args.attachmentIndexing,
		});
		return null;
	},
});
