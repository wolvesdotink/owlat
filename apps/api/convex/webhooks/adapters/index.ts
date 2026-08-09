/**
 * PROVIDER FEEDBACK ADAPTER REGISTRY — the feedback plane's seam (the seams
 * plan's D6, delivered by P2.1).
 *
 * A send transport that reports its own outcomes posts them to a route of ours.
 * That used to be a hand-wired pair per kind — a thin `httpAction` file at the
 * convex root (`sesWebhook.ts`, `resendWebhook.ts`, `mtaWebhook.ts`,
 * `mandrillWebhook.ts`), each doing nothing but naming an adapter, plus the
 * route in `http.ts` that imported it. Four files that had to be remembered, all
 * saying the same sentence, and nothing anywhere said they had to exist: a kind
 * could declare `hasProviderFeedback: true`, get a panel in the delivery UI
 * telling an operator to paste an endpoint into a provider console, and have no
 * endpoint behind it.
 *
 * Adding a feedback-reporting provider is now: write `./<kind>.ts`, add one line
 * here, add the static route in `http.ts`. The first two are compile-enforced by
 * the guards below; the third is enforced at runtime by
 * `lib/sendProviders/__tests__/feedbackRoutes.test.ts`, which walks the real
 * router.
 *
 * THE ROUTES STAY STATIC AND PER KIND — one `http.route({ path: '/webhooks/ses',
 * … })` literal each, never a loop over this registry and never a path derived
 * from a kind. Those URLs are already pasted into provider consoles we do not
 * own; a derived route is a route that can move itself, and a moved webhook URL
 * is silent on our side and total on theirs (events simply stop). What collapsed
 * is the HANDLER — `providerFeedbackWebhook(kind)` in `../providerFeedbackHttp.ts`
 * is the one dispatcher all of them share.
 *
 * WHAT THIS IS NOT. `channels.ts` registers the OTHER adapters in this folder
 * (`twilio`, `meta`, `generic`) — inbound SMS/WhatsApp/webhook channels, not
 * send transports, with no catalog entry and no kind. And this is not the plugin
 * platform's reserved `inboundAdapters` contribution bucket, which is held for
 * genuine inbound-MAIL sources; conflating the two is deliberately avoided (D6).
 * A plugin transport's feedback arrives on its own route surface keyed by plugin
 * id — the seams plan's P2.2.
 */

import { PROVIDER_FEEDBACK_CONTRIBUTIONS } from '../../providers/feedback';
import type { FeedbackReportingSendProviderKind } from '../../lib/sendProviders/catalog';
import type { AnyInboundAdapter } from '../pipeline';

/**
 * Keyed by send-provider kind — the same key `providerFeedback.webhookPath`
 * declares a route for and the same key the measurement plane grades an arm by.
 */
export const PROVIDER_FEEDBACK_ADAPTERS = Object.fromEntries(
	PROVIDER_FEEDBACK_CONTRIBUTIONS.flatMap(({ kind, contribution }) => {
		if (!['mta', 'ses', 'resend', 'mandrill'].includes(kind)) return [];
		return [[kind, contribution.parser]];
	})
) as { [K in FeedbackReportingSendProviderKind]: AnyInboundAdapter<K> };

/** The kinds this registry can dispatch. */
export type ProviderFeedbackKind = keyof typeof PROVIDER_FEEDBACK_ADAPTERS;

/**
 * Compile-time completeness guard (D6): every core kind whose catalog entry
 * declares `hasProviderFeedback: true` MUST have an adapter registered here, and
 * that adapter must identify itself BY THAT KEY.
 *
 * Both halves matter, and the second is not pedantry. `adapter.source` is what
 * the pipeline rate-limits under (`<source>:<ip>`, per-provider buckets so a
 * flood on one endpoint cannot 429 another's bounce feed) and what every stored
 * raw payload is filed under. A registry entry keyed `resend` holding the SES
 * adapter would serve forged-looking traffic from one provider out of another's
 * bucket and mislabel the audit trail, while every per-adapter suite stayed
 * green — they test adapters, not wiring.
 *
 * The mapped type pins each key to an adapter whose `source` is that key, so
 * both mistakes are build failures naming the kind.
 */
const _typecheck: { [K in FeedbackReportingSendProviderKind]: AnyInboundAdapter<K> } =
	PROVIDER_FEEDBACK_ADAPTERS;
void _typecheck;

/**
 * The converse, which is the direction that actually rots: an adapter
 * registered for a kind that declares NO feedback.
 *
 * It looks harmless — a route that works — and it is not: `hasProviderFeedbackFor`
 * is what the measurement plane reads to decide whether an arm's bounces arrive
 * out of band, and what the governed dispatch boundary reads to keep an ambiguous
 * acceptance non-terminal. Events that arrive for a kind the catalog says is
 * silent are events no consumer of that declaration expects, so they are graded
 * against the wrong tolerance. Registering here is therefore not the whole
 * decision; declaring it in the catalog is.
 *
 * (The mapped type above cannot say this: an object with extra properties is
 * still assignable to it.)
 */
type RegisteredKindWithoutDeclaration = Exclude<
	ProviderFeedbackKind,
	FeedbackReportingSendProviderKind
>;
type AssertEveryRegisteredAdapterIsDeclared<_T extends never> = true;
export type _RegisteredFeedbackAdaptersAreDeclared =
	AssertEveryRegisteredAdapterIsDeclared<RegisteredKindWithoutDeclaration>;

/**
 * Look up the adapter a kind's feedback route dispatches through.
 *
 * REGISTRATION IS `hasOwnProperty`, not truthiness — the same spelling
 * `domains/providers/index.ts` uses, for the same reason: a kind reaches the
 * lookup as a plain string in enough places (schema fields are
 * `v.optional(v.string())` for forward-compat) that `constructor` or
 * `__proto__` finding an inherited member on an object literal is a real shape.
 * Handing that back as an adapter fails one call later on
 * `adapter.verifySignature is not a function`, inside a webhook, instead of
 * accurately here.
 */
export function feedbackAdapterFor<K extends ProviderFeedbackKind>(
	kind: K
): (typeof PROVIDER_FEEDBACK_ADAPTERS)[K] {
	if (!Object.prototype.hasOwnProperty.call(PROVIDER_FEEDBACK_ADAPTERS, kind)) {
		throw new Error(`Unknown provider feedback adapter: ${kind}`);
	}
	return PROVIDER_FEEDBACK_ADAPTERS[kind];
}
