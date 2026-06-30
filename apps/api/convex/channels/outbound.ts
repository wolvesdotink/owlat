'use node';

/**
 * Outbound channel dispatch + credential encryption (NODE RUNTIME).
 *
 * This file is `'use node'` because it imports `lib/credentialCrypto`
 * (which pulls in `node:crypto`) and the `@owlat/channels` provider adapters.
 * Per the convention in lib/credentialCrypto.ts, anything that calls
 * encryptSecret/decryptSecret MUST live in a `'use node'` action file — never
 * a v8 query/mutation. Reached as `internal.channels.outbound.*`.
 *
 * Two responsibilities, both fed off the singleton-per-channel
 * `channelConfigs` row:
 *   1. `encryptAndPersistConfig` — the encrypt-on-write half of A3. The public
 *      `unifiedMessages.updateChannelConfig` mutation (v8) cannot encrypt
 *      itself, so it schedules this action with the plaintext config; we wrap
 *      it in an AES-256-GCM envelope (lib/credentialCrypto) and patch the row.
 *      The `channelConfigs.config` column therefore never holds plaintext on
 *      disk. Atomic single-org policy: no dual plaintext read path.
 *   2. `dispatchOutbound` — reads + decrypts the channel's creds, instantiates
 *      the matching adapter (sms→Twilio, whatsapp→Meta, generic→HTTP POST),
 *      sends, and records a `unifiedMessages` outbound row reflecting the
 *      SendResult. FAIL-SAFE: missing creds or a failed send records status
 *      `failed` and returns — it never throws into the calling pipeline. Stays
 *      fully inert until an operator configures credentials.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { outboundChannelValidator } from '../lib/convexValidators';
import { encryptSecret, decryptSecret } from '../lib/credentialCrypto';
import { SmsAdapter, WhatsAppAdapter, WebhookAdapter } from '@owlat/channels';
import type { ChannelAdapter, ChannelHealth, OutboundMessage, SendResult } from '@owlat/channels';
import {
	unifiedMessageChannelValidator as channelValidator,
} from '../lib/convexValidators';
import type { UnifiedMessageChannel, OutboundChannel } from '../lib/convexValidators';

/** Shape of the plaintext credential blob entered in the channel config form. */
interface ChannelCreds {
	// sms (Twilio)
	accountSid?: string;
	authToken?: string;
	phoneNumber?: string;
	// whatsapp (Meta Cloud API)
	businessAccountId?: string;
	accessToken?: string;
	phoneNumberId?: string;
	verifyToken?: string;
	// generic webhook
	endpointUrl?: string;
	secretKey?: string;
}

/**
 * Encrypt a plaintext channel `config` JSON string and persist the envelope on
 * the channelConfigs row. Scheduled by `unifiedMessages.updateChannelConfig`
 * so the plaintext is never written to disk. Fails safe: on any error the row
 * keeps its previous (encrypted) config rather than storing plaintext.
 */
export const encryptAndPersistConfig = internalAction({
	args: {
		channel: channelValidator,
		plaintextConfig: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const envelope = encryptSecret(args.plaintextConfig);
			await ctx.runMutation(internal.unifiedMessages.setChannelConfigSecret, {
				channel: args.channel,
				config: JSON.stringify(envelope),
			});
		} catch (error) {
			// Never throw out of the scheduled job — leave the prior config intact.
			// eslint-disable-next-line no-console
			console.error(
				`[channels] failed to encrypt config for ${args.channel}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return null;
	},
});

/**
 * Send a message out through a configured channel and record the result.
 *
 * FAIL-SAFE CONTRACT: this never throws. Missing/undecryptable creds, an
 * unsupported channel, or a provider rejection all resolve to a recorded
 * `failed` row (when a thread is known) and an early return. Inert until an
 * operator has configured + enabled the channel.
 */
export const dispatchOutbound = internalAction({
	args: {
		channel: channelValidator,
		contactId: v.id('contacts'),
		threadId: v.optional(v.id('conversationThreads')),
		content: v.object({
			text: v.optional(v.string()),
			mediaUrl: v.optional(v.string()),
			subject: v.optional(v.string()),
		}),
		// Set when this dispatch is the completion for an approved agent reply.
		// Channels have no sendCompletion module (unlike the MTA email path), so we
		// drive the inbound message to its terminal state from here, off the actual
		// send outcome.
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const record = async (status: 'sent' | 'failed', externalMessageId?: string, error?: string) => {
			// Recording the timeline row requires a thread (unifiedMessages.threadId
			// is non-null in the schema). The autonomy/routing + agent-reply callers
			// always supply one; if absent we log and skip the row.
			if (args.threadId) {
				await ctx.runMutation(internal.unifiedMessages.recordOutbound, {
					threadId: args.threadId,
					channel: args.channel,
					contactId: args.contactId,
					content: JSON.stringify(args.content),
					externalMessageId,
					status,
					...(error ? { metadata: JSON.stringify({ error }) } : {}),
				});
			} else {
				// eslint-disable-next-line no-console
				console.warn(`[channels] dispatchOutbound(${args.channel}) had no threadId; outbound row not recorded`);
			}

			// Completion for an approved agent reply: flip the inbound message off
			// the real outcome (sent vs failed), mirroring delivery/sendCompletion.
			if (args.inboundMessageId) {
				await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
					inboundMessageId: args.inboundMessageId,
					input:
						status === 'sent'
							? { to: 'sent', at: Date.now() }
							: { to: 'failed', at: Date.now(), errorMessage: error ?? 'Channel dispatch failed' },
				});
			}
		};

		// Read the channel config, decrypt its creds, and build the matching
		// adapter (Node-side). A null result means not-configured / undecryptable
		// / unsupported — all fail-safe failures from the dispatch perspective.
		const loaded = await loadAdapter(ctx, args.channel);
		if (loaded.adapter === null) {
			await record('failed', undefined, loaded.error);
			return null;
		}
		const adapter = loaded.adapter;

		// Resolve the recipient address/handle. The SMS/WhatsApp adapters read the
		// destination from `message.metadata.phoneNumber`; `generic` posts to a
		// fixed endpoint and needs no recipient lookup.
		let recipient: string | null = null;
		if (args.channel === 'sms' || args.channel === 'whatsapp') {
			recipient = await ctx.runQuery(internal.unifiedMessages.getContactChannelIdentifier, {
				contactId: args.contactId,
				channel: args.channel,
			});
			if (!recipient) {
				await record('failed', undefined, `Contact has no ${args.channel} address`);
				return null;
			}
		}

		const outbound: OutboundMessage = {
			contactId: args.contactId,
			channel: args.channel,
			content: args.content,
			...(args.threadId ? { threadId: args.threadId } : {}),
			...(recipient ? { metadata: { phoneNumber: recipient } } : {}),
		};

		let result: SendResult;
		try {
			result = await adapter.send(outbound);
		} catch (error) {
			// Adapters already catch internally, but never trust an external send.
			await record('failed', undefined, error instanceof Error ? error.message : String(error));
			return null;
		}

		if (result.success) {
			await record('sent', result.externalMessageId);
		} else {
			await record('failed', result.externalMessageId, result.error);
		}
		return null;
	},
});

/**
 * USER-INITIATED outbound send for a non-email channel (sms/whatsapp/generic).
 *
 * The fail-safe `dispatchOutbound` above is reached only from the AI agent reply
 * path; this is the manual counterpart — an owner/admin composing an outbound
 * message to a contact on a configured channel from the contact's Unified
 * Timeline. It resolves (or opens) the conversation thread, then schedules the
 * same `dispatchOutbound` so a manual send and an agent reply share one provider
 * path and one timeline writer.
 *
 * Unlike the agent path, misconfiguration here THROWS (channel disabled, no
 * contact address) so the admin sees the error in the compose UI rather than a
 * silent `failed` row. The provider call itself still runs through fail-safe
 * `dispatchOutbound`. Admin-only: a manual outbound on the shared inbox is a
 * support action, matching `unifiedMessages.sendChatMessage`.
 */
// authz: admin floor enforced via internal.auth.membership.assertOrgAdmin
// (organization:manage) inside the handler — actions can't call
// requireOrgPermission directly.
export const sendChannelMessage = authedAction({
	args: {
		contactId: v.id('contacts'),
		channel: outboundChannelValidator,
		text: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		// Admin floor (organization:manage) — actions can't run requireOrgPermission
		// directly, so assert through the internal query that inherits our identity.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		const text = args.text.trim();
		if (!text) throw new Error('Message cannot be empty');

		// Validate the send + resolve the thread (throws on a misconfiguration).
		const threadId = await ctx.runMutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId: args.contactId,
			channel: args.channel,
		});

		// Hand off to the shared fail-safe dispatch (records the outbound timeline
		// row off the real SendResult). No inboundMessageId: this is not an
		// agent-reply completion, so nothing flips an inbound message's lifecycle.
		await ctx.scheduler.runAfter(0, internal.channels.outbound.dispatchOutbound, {
			channel: args.channel,
			contactId: args.contactId,
			threadId,
			content: { text },
		});
		return null;
	},
});

/**
 * Poll the provider for the current delivery status of channel messages still
 * stuck at `sent`, and advance them (delivered/read/failed) in the unified
 * timeline. Closes the loop the channel adapters were built for: dispatch
 * records `sent` off the synchronous SendResult, but post-acceptance carrier
 * progression (Twilio status, etc.) only surfaces on a later poll. Without this
 * a successfully-sent SMS/WhatsApp/generic message would sit at `sent` forever.
 *
 * Runs on the `poll channel delivery status` cron. FAIL-SAFE like dispatch:
 * a missing config, an undecryptable cred, or a provider error leaves the row
 * untouched (still `sent`) and moves on — it never throws into the cron.
 */
export const pollDeliveryStatus = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const WINDOW_MS = 24 * 60 * 60 * 1000; // poll messages sent in the last 24h
		const LIMIT = 100;

		const pending = await ctx.runQuery(internal.unifiedMessages.listPendingDeliveryStatus, {
			sinceMs: WINDOW_MS,
			limit: LIMIT,
		});
		if (pending.length === 0) return null;

		// One adapter per channel, reused across that channel's pending messages.
		const adapterCache = new Map<OutboundChannel, ChannelAdapter | null>();
		const adapterFor = async (channel: OutboundChannel) => {
			if (!adapterCache.has(channel)) {
				const loaded = await loadAdapter(ctx, channel);
				adapterCache.set(channel, loaded.adapter);
			}
			return adapterCache.get(channel) ?? null;
		};

		for (const row of pending) {
			try {
				const adapter = await adapterFor(row.channel);
				if (!adapter) continue; // not configured / undecryptable — leave as `sent`
				const status = await adapter.getDeliveryStatus(row.externalMessageId);
				// `queued`/`sent` are not a forward transition — only persist a move
				// to a terminal/progressed state to avoid a no-op write every tick.
				if (status === 'delivered' || status === 'read' || status === 'failed') {
					await ctx.runMutation(internal.unifiedMessages.updateDeliveryStatus, {
						messageId: row.messageId,
						status,
					});
				}
			} catch {
				// Fail-safe: a provider/network error means the status is simply
				// unknown right now; leave the row at `sent` and re-poll next tick.
			}
		}
		return null;
	},
});

/**
 * Probe the real connectivity of a configured outbound channel and persist the
 * result on its `channelConfigs` row (NODE RUNTIME — decrypts creds + builds the
 * adapter via the shared `loadAdapter` seam).
 *
 * Scheduled per-channel by the `channel health checks` cron
 * (`unifiedMessages.runChannelHealthChecks`), which cannot probe itself: the
 * adapter probe needs `node:crypto` to decrypt the stored creds, so it must run
 * in a `'use node'` action rather than the v8 cron orchestrator. Calls the
 * adapter's `healthCheck()` (SmsAdapter pings Twilio, WhatsAppAdapter pings the
 * Meta graph, WebhookAdapter is config-only) so a channel with revoked/invalid
 * credentials reports `degraded`/`down` instead of a config-presence `healthy`.
 *
 * FAIL-SAFE like the rest of this file: an undecryptable cred or a probe that
 * throws records `down` and returns — it never throws into the cron.
 */
export const probeChannelHealth = internalAction({
	args: {
		channel: channelValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		let health: ChannelHealth;
		try {
			const loaded = await loadAdapter(ctx, args.channel);
			if (loaded.adapter === null) {
				health = { status: 'down', lastError: loaded.error };
			} else {
				health = await loaded.adapter.healthCheck();
			}
		} catch (error) {
			health = {
				status: 'down',
				lastError: error instanceof Error ? error.message : String(error),
			};
		}

		await ctx.runMutation(internal.unifiedMessages.updateChannelHealth, {
			channel: args.channel,
			healthStatus: health.status,
			...(health.lastError !== undefined ? { lastError: health.lastError } : {}),
		});
		return null;
	},
});

/**
 * Read + decrypt a channel's stored creds and build its provider adapter
 * (Node-side). Shared by `dispatchOutbound` and `pollDeliveryStatus`. Returns
 * `{ adapter: null, error }` for every fail-safe case (not configured,
 * undecryptable, unsupported channel) so callers handle them uniformly.
 */
async function loadAdapter(
	ctx: ActionCtx,
	channel: UnifiedMessageChannel,
): Promise<{ adapter: ChannelAdapter; error?: undefined } | { adapter: null; error: string }> {
	const config = await ctx.runQuery(internal.unifiedMessages.getChannelConfigInternal, {
		channel,
	});
	if (!config || !config.isEnabled || !config.config) {
		return { adapter: null, error: 'Channel not configured' };
	}

	let creds: ChannelCreds;
	try {
		const envelope = JSON.parse(config.config) as {
			ciphertext: string;
			iv: string;
			authTag: string;
			version: number;
		};
		creds = JSON.parse(decryptSecret(envelope)) as ChannelCreds;
	} catch {
		return { adapter: null, error: 'Could not decrypt channel credentials' };
	}

	const adapter = buildAdapter(channel, creds);
	if (!adapter) {
		return { adapter: null, error: `Channel ${channel} does not support outbound dispatch` };
	}
	return { adapter };
}

/**
 * Build + configure the provider adapter for a channel from decrypted creds.
 * Returns null for channels with no outbound provider here (email is owned by
 * the MTA send pipeline; chat is native). Missing fields yield a configured
 * adapter that simply returns a failed SendResult — the fail-safe path.
 */
function buildAdapter(channel: string, creds: ChannelCreds): ChannelAdapter | null {
	switch (channel) {
		case 'sms': {
			const adapter = new SmsAdapter();
			adapter.configure({
				accountSid: creds.accountSid ?? '',
				authToken: creds.authToken ?? '',
				fromNumber: creds.phoneNumber ?? '',
			});
			return adapter;
		}
		case 'whatsapp': {
			const adapter = new WhatsAppAdapter();
			adapter.configure({
				phoneNumberId: creds.phoneNumberId ?? '',
				accessToken: creds.accessToken ?? '',
				verifyToken: creds.verifyToken ?? '',
			});
			return adapter;
		}
		case 'generic': {
			const adapter = new WebhookAdapter();
			adapter.configure({
				outboundUrl: creds.endpointUrl ?? '',
				secret: creds.secretKey ?? '',
			});
			return adapter;
		}
		default:
			return null;
	}
}
