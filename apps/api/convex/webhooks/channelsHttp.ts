/**
 * Channel webhook routes — the HTTP shells for the inbound event pipeline.
 *
 * Per-provider verification, payload parsing, and per-channel
 * `channel.received` event construction live in
 * `webhooks/adapters/<provider>.ts` (Twilio, Meta, generic). The pipeline
 * (`webhooks/pipeline.ts`) owns rate-limiting, audit-payload storage, dispatch
 * and response shaping; the dispatcher (`webhooks/dispatcher.ts`) routes
 * `channel.received` to `processInboundChannel` in the sibling
 * `webhooks/channels.ts`.
 *
 * The only non-pipeline concern here is Meta's GET verification challenge —
 * not an Inbound event but a one-shot protocol handshake. `handleMetaChallenge`
 * lives in the Meta adapter module and runs in the outer shell before
 * `runInboundPipeline`.
 *
 * Security guarantees (fail-closed): every adapter rejects with 503 when it has
 * no secret to verify against. The secret is the credential stored on the
 * channel's own `channelConfigs` row, falling back to the deployment env var
 * (`webhooks/channelSecrets.ts`). Never accept an unsigned request "for now."
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
	if (request.method === 'GET') return await handleMetaChallenge(request, ctx);
	return runInboundPipeline(ctx, request, metaAdapter);
});

/**
 * Generic shared-secret webhook handler
 * POST /webhooks/channel
 */
export const handleGenericWebhook = httpAction((ctx, request) =>
	runInboundPipeline(ctx, request, genericAdapter)
);
