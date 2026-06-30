/**
 * Channel Webhook Handlers
 *
 * Thin HTTP shells over the inbound event pipeline. Per-provider
 * verification, payload parsing, and per-channel `channel.received` event
 * construction live in `webhooks/adapters/<provider>.ts` (Twilio, Meta,
 * generic). The pipeline (`webhooks/pipeline.ts`) owns rate-limiting,
 * audit-payload storage, dispatch, and response shaping; the dispatcher
 * (`webhooks/dispatcher.ts`) routes `channel.received` to
 * `processInboundChannel` below.
 *
 * The only non-pipeline concern in this file is Meta's GET verification
 * challenge — it's not an Inbound event but a one-shot protocol
 * handshake. `handleMetaChallenge` lives in the Meta adapter module and
 * runs in the outer shell before `runInboundPipeline`.
 *
 * Security guarantees (fail-closed): every adapter rejects with 503 when
 * its required secret env var is unset. Never accept an unsigned request
 * "for now."
 */

import { httpAction } from '../_generated/server';
import { runInboundPipeline } from './pipeline';
import { twilioAdapter } from './adapters/twilio';
import { genericAdapter } from './adapters/generic';
import { metaAdapter, handleMetaChallenge } from './adapters/meta';

/**
 * Twilio SMS webhook handler
 * POST /webhooks/sms
 */
export const handleSmsWebhook = httpAction((ctx, request) =>
	runInboundPipeline(ctx, request, twilioAdapter)
);

/**
 * WhatsApp (Meta) webhook handler
 * POST /webhooks/whatsapp — inbound message (goes through the pipeline)
 * GET  /webhooks/whatsapp — Meta verification challenge (out-of-band)
 */
export const handleWhatsAppWebhook = httpAction(async (ctx, request) => {
	if (request.method === 'GET') return handleMetaChallenge(request);
	return runInboundPipeline(ctx, request, metaAdapter);
});

/**
 * Generic shared-secret webhook handler
 * POST /webhooks/channel
 */
export const handleGenericWebhook = httpAction((ctx, request) =>
	runInboundPipeline(ctx, request, genericAdapter)
);

// ============================================================
// Internal mutation: process inbound channel message
// ============================================================

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { createContact } from '../contacts/creation';
import { findOrCreateForChannel } from '../inbox/threads/module';
import { isFeatureEnabled } from '../lib/featureFlags';
import { logError } from '../lib/runtimeLog';

/**
 * Process an inbound message from any non-email channel.
 * Creates/resolves thread and contact, stores unified message.
 */
export const processInboundChannel = internalMutation({
	args: {
		channel: v.union(
			v.literal('sms'),
			v.literal('whatsapp'),
			v.literal('generic'),
			v.literal('chat')
		),
		from: v.string(),
		content: v.string(),
		externalMessageId: v.optional(v.string()),
		metadata: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		// Find or create contact via the Contact resolution module. Each
		// channel is its own identity keyspace — a `generic`-channel
		// `john@example.com` is NOT the same Contact as an `email`-channel
		// `john@example.com`. Cross-channel unification is an explicit
		// operation via `contacts.identities.mergeContacts`. Non-email
		// channels leave `contacts.email` undefined (no more fake-domain
		// hack).
		const { contactId } = await createContact(ctx, {
			channel: args.channel,
			identifier: args.from,
			source: 'inbound',
			mode: 'upsert',
		});

		// Find or create thread via the Conversation thread module. The
		// matcher is status-agnostic — a closed most-recent thread is matched
		// and reopened (by the shared inbound_activity reducer) rather than
		// forked, so channels now follow the same reopen policy as email
		// (ADR-0032 §1). `contactIdentifier` is the channel-neutral thread-list
		// identifier (the raw phone/handle for SMS/WhatsApp/chat).
		const { threadId } = await findOrCreateForChannel(ctx, {
			contactId,
			contactIdentifier: args.from,
			subject: `${args.channel.toUpperCase()} conversation`,
			normalizedSubject: `${args.channel} conversation`,
			occurredAt: now,
		});

		// Store unified message
		await ctx.db.insert('unifiedMessages', {
			threadId,
			channel: args.channel,
			direction: 'inbound',
			contactId,
			content: args.content,
			externalMessageId: args.externalMessageId,
			status: 'received',
			metadata: args.metadata,
			createdAt: now,
		});

		// Feed the channel message into the SAME agent pipeline as email by
		// projecting it onto an `inboundMessages` row and starting the agent
		// walker. The walker is `inboundMessages`-shaped, so this is the seam
		// that unifies channel + email intake.
		//
		// Best-effort: the inbound webhook's job is durable storage of the
		// message (done above). A misconfigured / disabled agent must never
		// turn a stored inbound into a 5xx that makes the provider retry. We
		// only schedule when the `ai.agent` flag is on, and any failure here
		// is logged and swallowed.
		try {
			if (await isFeatureEnabled(ctx, 'ai.agent')) {
				// Channel messages have no SMTP envelope. Map the channel fields
				// onto the email-shaped row: `from` is the sender identifier,
				// `to` is the channel name, the subject is a synthetic first
				// line, and `messageId` falls back to a synthetic id when the
				// provider gave no external id (so `by_message_id` stays unique).
				const subject =
					args.content.trim().slice(0, 80) ||
					`${args.channel.toUpperCase()} message`;
				const messageId =
					args.externalMessageId ?? `${args.channel}:${threadId}:${now}`;

				const inboundMessageId = await ctx.db.insert('inboundMessages', {
					messageId,
					from: args.from,
					to: args.channel,
					subject,
					textBody: args.content,
					threadId,
					contactId,
					processingStatus: 'received',
					receivedAt: now,
				});

				await ctx.scheduler.runAfter(0, internal.agent.walker.start, {
					inboundMessageId,
				});
			}
		} catch (err) {
			logError('[Channel Webhook] Failed to start agent pipeline:', err);
		}
	},
});
