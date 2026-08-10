/**
 * Send-provider feedback webhook — ONE HTTP entry point for every kind.
 *
 * The four thin `httpAction` files this replaces (`resendWebhook.ts`,
 * `sesWebhook.ts`, `mtaWebhook.ts`, `mandrillWebhook.ts` at the convex root)
 * each held the same two lines: name an adapter, hand it to
 * `runInboundPipeline`. All webhook ceremony — rate limit, signature
 * verification, audit storage, event parsing, dispatch — lives in
 * `./pipeline.ts` and the per-kind adapter, and always did; the files were
 * ceremony ABOUT the ceremony. See CONTEXT.md "Webhook dispatcher" and "Inbound
 * adapter", and the seams plan's D6/P2.1.
 *
 * WHAT THE PARAMETER IS AND IS NOT. `providerFeedbackWebhook(kind)` picks the
 * adapter; it does NOT pick the route. Each kind keeps its own static
 * `http.route({ path: '/webhooks/<kind>', method: 'POST', … })` registration with
 * the path written out as a literal, because those URLs are already configured
 * in provider consoles nobody here can edit. The declared side of that pair is
 * `providerFeedback.webhookPath` in the catalog (what the delivery page tells an
 * operator to paste), and the two are cross-checked by
 * `lib/sendProviders/__tests__/feedbackRoutes.test.ts`.
 */

import { httpAction } from '../_generated/server';
import { feedbackAdapterFor, type ProviderFeedbackKind } from './adapters';
import { runInboundPipeline } from './pipeline';

/**
 * The POST handler for one kind's feedback route.
 *
 * The adapter is resolved WHEN THE ROUTE IS BUILT, not per request: a kind with
 * no registered adapter then fails at module load — visible the moment the
 * backend is pushed — rather than answering 500 to a provider that will retry,
 * back off, and eventually disable the endpoint. The registry's compile-time
 * guards make that unreachable; this is what happens if they are ever bypassed.
 */
export function providerFeedbackWebhook(kind: ProviderFeedbackKind) {
	const adapter = feedbackAdapterFor(kind);
	return httpAction(async (ctx, request) => runInboundPipeline(ctx, request, adapter));
}

/**
 * The UNSIGNED URL-validation probe some provider consoles send before they will
 * save a webhook URL: no batch to parse, no signature to check, nothing to
 * dispatch — so it is answered out of band rather than through the POST-only
 * pipeline, which would (correctly) reject it.
 *
 * Mandrill is the kind that needs it today. It sends a HEAD, which Convex's
 * router resolves to the GET handler, which is why one route registration covers
 * both. The Meta channel adapter's GET verification challenge
 * (`./channels.ts`) is the same idea with a payload; this one has nothing to
 * echo back, so it is kind-independent and shared rather than reimplemented per
 * provider.
 *
 * The OTHER probe — a signed POST carrying an empty batch — deliberately DOES go
 * through the pipeline: it is a real signed request, so it must prove the
 * configured key works. It parses to zero events and is acknowledged without
 * dispatching anything.
 */
export const webhookUrlValidationProbe = httpAction(
	async () => new Response(null, { status: 200 })
);
