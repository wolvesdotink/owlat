/**
 * Mailchimp Transactional (Mandrill) webhook HTTP endpoint.
 *
 * All webhook ceremony (rate limit, signature verification, audit storage,
 * batch parsing, dispatch) lives in `webhooks/pipeline.ts` and
 * `webhooks/adapters/mandrill.ts`. See CONTEXT.md "Webhook dispatcher" and
 * "Inbound adapter", and plan D10.
 *
 * Webhook URL: POST /webhooks/mandrill
 *
 * Mandrill validates a webhook URL before it will save it, with an UNSIGNED
 * HEAD request — there is no batch to verify and no signature to check, so it
 * is answered out-of-band by `handleMandrillPing` rather than through the
 * POST-only pipeline. Convex's router resolves HEAD to the GET handler, which
 * is why one route registration covers both. This mirrors the Meta adapter's
 * GET verification challenge (`webhooks/channels.ts`).
 *
 * The OTHER probe — a signed POST carrying `mandrill_events=[]` — deliberately
 * does go through the pipeline: it is a real signed request, so it must prove
 * the configured key works. It parses to zero events and is acknowledged
 * without dispatching anything.
 */

import { httpAction } from './_generated/server';
import { mandrillAdapter } from './webhooks/adapters/mandrill';
import { runInboundPipeline } from './webhooks/pipeline';

export const handleMandrillWebhook = httpAction(async (ctx, request) =>
	runInboundPipeline(ctx, request, mandrillAdapter)
);

/** Mandrill's unsigned HEAD/GET URL-validation probe. Acknowledges, does nothing. */
export const handleMandrillPing = httpAction(async () => new Response(null, { status: 200 }));
