/**
 * AWS SES / SNS webhook HTTP endpoint.
 *
 * All webhook ceremony (rate limit, signature verification, audit storage,
 * event parsing, dispatch) lives in `webhooks/pipeline.ts` and
 * `webhooks/adapters/ses.ts`. See CONTEXT.md "Webhook dispatcher" and
 * "Inbound adapter".
 *
 * Webhook URL: POST /webhooks/ses
 *
 * SNS envelope types handled (parsed by the adapter, routed by the dispatcher):
 *   SubscriptionConfirmation → internal.sns_subscription_confirm (confirm fetch)
 *   Notification / Bounce     → email.bounced   (suppression + reputation)
 *   Notification / Complaint  → email.complained (suppression + reputation)
 *   Notification / Delivery   → email.delivered  (send lifecycle)
 *   UnsubscribeConfirmation   → ignored (acknowledged)
 */

import { httpAction } from './_generated/server';
import { sesAdapter } from './webhooks/adapters/ses';
import { runInboundPipeline } from './webhooks/pipeline';

export const handleSesWebhook = httpAction(async (ctx, request) =>
	runInboundPipeline(ctx, request, sesAdapter)
);
