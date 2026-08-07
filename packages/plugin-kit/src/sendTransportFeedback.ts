/**
 * The FEEDBACK half of a bundled send transport (the seams plan's D6): the event
 * vocabulary a plugin's webhook module may report, the two limits one delivery is
 * bound by, and the parse-only module contract itself.
 *
 * Split out of `./sendTransport` because it is a different conversation with a
 * different actor: the send contract is Owlat calling a plugin to put a message
 * on the wire, this one is a provider's HTTP delivery being turned into facts the
 * measurement plane consumes. The manifest DESCRIPTOR that declares a webhook
 * (`PluginSendTransportWebhookDefinition`) stays beside the transport definition
 * it hangs off.
 */

/**
 * The feedback vocabulary a plugin transport may report, as the four facts the
 * measurement plane and the Send lifecycle actually consume.
 *
 * Deliberately narrower than the host's own inbound event union: opens, clicks
 * and first-party unsubscribes come from Owlat's surfaces, not a relay's
 * counters, and a kind the host cannot attribute is a kind a plugin could use to
 * write rows nothing audits. A new member is a host change, by design.
 */
export const PLUGIN_WEBHOOK_FEEDBACK_KINDS = [
	'delivered',
	'bounced',
	'complained',
	'deferred',
] as const;

export type PluginWebhookFeedbackKind = (typeof PLUGIN_WEBHOOK_FEEDBACK_KINDS)[number];

/**
 * One normalized feedback fact.
 *
 * `providerMessageId` is the id the transport's own `send` returned, which is
 * how the host joins the event to a Send. A complaint may instead carry only
 * `recipient` (RFC 5965 §3.2 redaction is routine), and the host suppresses by
 * address in that case — the one place an address alone is enough.
 *
 * Every field is re-validated by the host before it is trusted: plugin output is
 * untrusted input, exactly as a send attempt's result is.
 */
export type PluginWebhookFeedbackEvent =
	| {
			readonly kind: 'delivered';
			readonly providerMessageId: string;
			/** Provider's event time, epoch milliseconds. */
			readonly at: number;
			readonly recipient?: string;
	  }
	| {
			readonly kind: 'bounced';
			readonly providerMessageId: string;
			readonly at: number;
			readonly bounceType: 'hard' | 'soft';
			readonly bounceMessage?: string;
	  }
	| {
			readonly kind: 'complained';
			readonly at: number;
			readonly providerMessageId?: string;
			readonly recipient?: string;
	  }
	| {
			readonly kind: 'deferred';
			readonly providerMessageId: string;
			readonly at: number;
			/** Provider free text, for operator logs only. */
			readonly reason?: string;
	  };

/**
 * Largest request body the feedback route reads, in BYTES of UTF-8 (not string
 * length). Over it, the provider is answered `413` before the module is called.
 */
export const PLUGIN_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/**
 * Largest batch one delivery may carry, as a count of returned events.
 *
 * Sized to what fits in {@link PLUGIN_WEBHOOK_MAX_BODY_BYTES} at the ~200 bytes
 * of JSON a feedback record costs, so the two limits bind at about the same
 * place. Declared here, in the contract an author reads, because an over-limit
 * batch is answered `413` and REDELIVERED IDENTICALLY by the provider until it
 * gives up: the feedback in it is lost, not delayed, and the fix (ask the
 * provider to chunk) is only available to an author who knows the number.
 */
export const PLUGIN_WEBHOOK_MAX_BATCH_EVENTS = 5_000;

/**
 * The webhook half of a bundled send transport: PARSE ONLY.
 *
 * There is no `verifySignature` here, and its absence is the contract. The host
 * has already verified the declared signature, enforced timestamp freshness and
 * rejected a replayed delivery before this module is called, so `rawBody` is
 * authentic bytes from the provider the plugin integrates. Giving a plugin the
 * authenticity decision would make the strength of an internet-facing endpoint a
 * property of third-party code.
 *
 * Return the empty array for a batch that carries nothing Owlat acts on — that
 * is how a provider's verification ping and its unconsumed event kinds are
 * acknowledged. Throwing is answered 400 without dispatching anything.
 *
 * TWO LIMITS BOUND WHAT ONE DELIVERY MAY CARRY, and both are the provider's to
 * respect, not yours to work around: {@link PLUGIN_WEBHOOK_MAX_BODY_BYTES} on
 * the request body, and {@link PLUGIN_WEBHOOK_MAX_BATCH_EVENTS} on the events
 * you return. Either is answered `413` — never a partial application — and the
 * provider will redeliver the same oversized delivery, so configure it to chunk
 * rather than expecting Owlat to split what it refused.
 *
 * This module runs inside the HTTP router's isolate, so it must not import Node
 * builtins; parsing a JSON or form body needs none.
 */
export interface PluginSendTransportWebhookModule {
	parseEvents(rawBody: string): readonly PluginWebhookFeedbackEvent[];
}
