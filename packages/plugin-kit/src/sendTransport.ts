import type { PluginReplayBoundSignatureContract } from './inboundSignature';
import type { PluginLocalId, PluginNamespacedKind } from './namespacedKind';

/** Capability assigned by the host to every bundled send transport. */
export const PLUGIN_SEND_TRANSPORT_CAPABILITY = 'send:transport' as const;

export type PluginSendTransportCapability = typeof PLUGIN_SEND_TRANSPORT_CAPABILITY;

/** Local contribution identity. The host namespaces it with the owning plugin id. */

/** Collision-safe transport kind stored in routes and health records. */
export type PluginSendTransportKind = PluginNamespacedKind;

/** A condition-independent package export verified and imported by codegen. */
export interface PluginStaticModuleExport {
	readonly exportPath: string;
}

/**
 * The feedback half of a send-transport bundle: how the provider's bounces,
 * complaints, deliveries and deferrals get back in (the seams plan's D6, wired
 * by P2.2).
 *
 * It is a MODULE EXPORT ON THE SEND TRANSPORT, not a bucket of its own. A
 * provider's send path and its feedback path are one integration — the same
 * account, the same credentials, the same operator decision — and the reserved
 * `inboundAdapters` bucket means something else entirely (genuine inbound MAIL
 * sources). Keeping them apart is deliberate.
 *
 * THE SPLIT OF RESPONSIBILITY. The host owns authenticity: it verifies the
 * declared `signature` contract against the raw body in constant time, enforces
 * the timestamp freshness that contract's `replay` provisions require, and
 * refuses a delivery it has already accepted. The plugin owns only semantics —
 * turning verified bytes into the events below. A webhook declared without a
 * `signature` FAILS MANIFEST VALIDATION: this endpoint is unauthenticated and
 * internet-facing by design, so an unverified one would be an open write path
 * into the delivery record.
 */
export interface PluginSendTransportWebhookDefinition {
	/** The parse-only module (isolate-safe: it runs inside the HTTP router). */
	readonly module: PluginStaticModuleExport;
	/** Required. Host-verified; a plugin can neither weaken nor bypass it. */
	readonly signature: PluginReplayBoundSignatureContract;
	/**
	 * OPT-IN raw-payload retention. When true, the host stores the verified raw
	 * request body in its webhook audit log, as it does for the core providers.
	 * Default false: a third party's payload may carry recipient content this
	 * deployment never asked to keep, so retention is the adapter's explicit
	 * decision rather than the pipeline's default.
	 */
	readonly storeRawPayload?: boolean;
}

/** Data-only manifest descriptor. Executable code lives at `module.exportPath`. */
export interface PluginSendTransportDefinition {
	readonly id: PluginLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Host-owned delays after retryable failures; at most three bounded entries. */
	readonly retryDelays: readonly number[];
	/**
	 * Optional feedback webhook. AT MOST ONE send transport per plugin may
	 * declare one, because the route surface is keyed by plugin id
	 * (`/webhooks/plugin/<pluginId>`) and a second declaration would have no way
	 * to be addressed.
	 */
	readonly webhook?: PluginSendTransportWebhookDefinition;
}

export interface PluginSendAttachment {
	readonly filename: string;
	readonly content: Uint8Array;
	readonly contentType?: string;
}

/** Host-normalized message passed to one trusted bundled transport attempt. */
export interface PluginSendTransportParams {
	readonly to: string;
	readonly from: string;
	readonly subject: string;
	readonly html: string;
	readonly text?: string;
	readonly replyTo?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly attachments?: readonly PluginSendAttachment[];
}

/** Typed terminal/retry semantics. Plugins never control host error text. */
export const PLUGIN_SEND_FAILURE_CODES = [
	'rate_limited',
	'temporary_failure',
	'ambiguous_timeout',
	'invalid_recipient',
	'invalid_sender',
	'authentication_failed',
	'content_rejected',
	'unknown',
] as const;

export type PluginSendFailureCode = (typeof PLUGIN_SEND_FAILURE_CODES)[number];

export type PluginSendAttempt =
	| { readonly success: true; readonly id: string }
	| { readonly success: false; readonly code: PluginSendFailureCode };

/**
 * Executable Node module exported by a bundled plugin.
 *
 * `parseExtras` is the sole unknown-input boundary and must either return the
 * transport's honest extras type or throw. `send` performs exactly one network
 * attempt; Owlat owns authorization, retries, health, and audit.
 */
export interface PluginSendTransportModule<Extras = unknown> {
	parseExtras(input: unknown): Extras;
	send(params: PluginSendTransportParams, extras: Extras): Promise<PluginSendAttempt>;
}

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
 * This module runs inside the HTTP router's isolate, so it must not import Node
 * builtins; parsing a JSON or form body needs none.
 */
export interface PluginSendTransportWebhookModule {
	parseEvents(rawBody: string): readonly PluginWebhookFeedbackEvent[];
}
