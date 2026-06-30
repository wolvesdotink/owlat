/**
 * Resend webhook HTTP endpoint.
 *
 * All webhook ceremony (rate limit, signature verification, audit storage,
 * event parsing, dispatch) lives in `webhooks/pipeline.ts` and
 * `webhooks/adapters/resend.ts`. See CONTEXT.md "Webhook dispatcher" and
 * "Inbound adapter".
 *
 * Webhook URL: POST /webhooks/resend
 */

import { httpAction } from './_generated/server';
import { resendAdapter } from './webhooks/adapters/resend';
import { runInboundPipeline } from './webhooks/pipeline';

export const handleResendWebhook = httpAction(async (ctx, request) =>
	runInboundPipeline(ctx, request, resendAdapter)
);
