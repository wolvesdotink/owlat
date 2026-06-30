/**
 * MTA webhook HTTP endpoint.
 *
 * All webhook ceremony (rate limit, signature verification, audit storage,
 * event parsing, dispatch) lives in `webhooks/pipeline.ts` and
 * `webhooks/adapters/mta.ts`. See CONTEXT.md "Webhook dispatcher" and
 * "Inbound adapter".
 *
 * Webhook URL: POST /webhooks/mta
 *
 * Events handled (parsed by the adapter, routed by the dispatcher):
 *   email.sent / email.bounced / email.complained          — Send lifecycle
 *   email.sent / email.bounced (with `pb-` messageId)      — Postbox outbound state
 *   inbound.received                                       — inbox.messages
 *   internal.circuit_breaker_tripped                       — org abuse status
 *   internal.campaign_complaint_rate                       — org abuse status
 *   internal.ip_event (blocklisted/delisted/warming_complete/all_blocked)
 *                                                          — warmingSync + log
 */

import { httpAction } from './_generated/server';
import { mtaAdapter } from './webhooks/adapters/mta';
import { runInboundPipeline } from './webhooks/pipeline';

export const handleMtaWebhook = httpAction(async (ctx, request) =>
	runInboundPipeline(ctx, request, mtaAdapter)
);
