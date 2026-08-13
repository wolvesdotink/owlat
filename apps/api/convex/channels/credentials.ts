'use node';

/**
 * Per-channel credential vault (NODE RUNTIME).
 *
 * `channelConfigs.config` holds one AES-256-GCM envelope per channel — the
 * credentials an owner/admin typed into Settings → Channels, encrypted on write
 * by `channels.outbound.encryptAndPersistConfig`. Opening that envelope needs
 * `lib/credentialCrypto`, which is `node:crypto`, so every reader has to live in
 * a `'use node'` file. This module is that reader, and both planes that need a
 * stored credential go through it:
 *
 *   - OUTBOUND (`./outbound.ts`, same runtime) imports `decryptChannelCreds`
 *     directly and builds the provider adapter from the result.
 *   - INBOUND (`webhooks/adapters/{twilio,meta,generic}.ts`) runs in v8 http
 *     actions that cannot import `node:crypto` at all, so it reaches the one
 *     secret it needs through the `getInboundSecret` action below (wrapped by
 *     `webhooks/channelSecrets.ts`, which adds the env-var fallback).
 *
 * Reached as `internal.channels.credentials.*`.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { decryptSecret } from '../lib/credentialCrypto';
import type { EncryptedEnvelope } from '../lib/credentialCrypto';
import { outboundChannelValidator } from '../lib/convexValidators';
import type { OutboundChannel } from '../lib/convexValidators';

/**
 * Shape of the plaintext credential blob entered in the channel config form
 * (`apps/web/app/components/channels/ChannelConfigForm.vue`). This mirrors that
 * form exactly — every key the form can write is listed and nothing else, so a
 * field with no reader cannot masquerade as a stored credential.
 */
export interface ChannelCreds {
	// sms (Twilio). `authToken` does double duty: it is the outbound API
	// credential AND the key Twilio signs its inbound webhooks with, so SMS
	// needs no separate inbound field.
	accountSid?: string;
	authToken?: string;
	phoneNumber?: string;
	// whatsapp (Meta Cloud API)
	businessAccountId?: string; // stored only — the send call is keyed on phoneNumberId
	accessToken?: string;
	phoneNumberId?: string;
	appSecret?: string; // inbound only — the X-Hub-Signature-256 HMAC key
	verifyToken?: string; // inbound only — answers Meta's GET subscription challenge
	// generic webhook
	endpointUrl?: string;
	secretKey?: string; // inbound only — the shared secret the caller echoes back
}

/**
 * The stored field each channel's inbound signature check verifies against.
 * Keyed by channel because the three schemes disagree about which credential
 * signs: Twilio reuses the account auth token, Meta uses the app secret, and
 * the generic webhook compares a plain shared secret.
 */
const INBOUND_SIGNING_FIELD: Record<OutboundChannel, keyof ChannelCreds> = {
	sms: 'authToken',
	whatsapp: 'appSecret',
	generic: 'secretKey',
};

/** Which stored secret an inbound caller is asking for. */
export const channelSecretFieldValidator = v.union(
	v.literal('signature'),
	v.literal('verifyToken')
);

/**
 * Open a stored `channelConfigs.config` envelope. Returns null for anything
 * that is not a decryptable envelope (tampered, encrypted under a rotated
 * INSTANCE_SECRET, or a row from before encrypt-on-write) — every caller here
 * is fail-safe and treats null as "not configured".
 */
export function decryptChannelCreds(config: string): ChannelCreds | null {
	try {
		const envelope = JSON.parse(config) as EncryptedEnvelope;
		return JSON.parse(decryptSecret(envelope)) as ChannelCreds;
	} catch {
		return null;
	}
}

/**
 * Hand an inbound webhook route the secret its channel was configured with.
 *
 * NOT gated on `isEnabled`. Inbound acceptance has never depended on the
 * channel toggle (the toggle governs health monitoring and outbound), and
 * making it do so here would silently fall the route back to the deployment
 * env var the moment an operator flipped a channel off — a quieter and more
 * surprising outcome than the toggle simply not applying to inbound.
 *
 * Returns null when the channel has no row, no envelope, an undecryptable
 * envelope, or an empty value for the field; the caller
 * (`webhooks/channelSecrets.ts`) then falls back to the env var and, failing
 * that, fails the request closed with a 503.
 */
export const getInboundSecret = internalAction({
	args: {
		channel: outboundChannelValidator,
		field: channelSecretFieldValidator,
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const config = await ctx.runQuery(internal.unifiedMessages.getChannelConfigInternal, {
			channel: args.channel,
		});
		if (!config?.config) return null;

		const creds = decryptChannelCreds(config.config);
		if (!creds) return null;

		const key = args.field === 'verifyToken' ? 'verifyToken' : INBOUND_SIGNING_FIELD[args.channel];
		const value = creds[key];
		return typeof value === 'string' && value.length > 0 ? value : null;
	},
});
