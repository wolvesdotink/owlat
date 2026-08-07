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

/**
 * Does this transport let the host choose the RFC5321.MailFrom on a send — the
 * catalog's `supportsCustomReturnPath` (the seams plan's D1), as a plugin may
 * declare it.
 *
 *  - `yes` the transport honours an envelope sender we name, so the routing pass
 *          resolves one and hands it to {@link PluginSendTransportModule.buildDispatchExtras}
 *          as {@link PluginSendDispatchContext.returnPathHost}. Declaring it
 *          without forwarding it is a promise the module does not keep: the
 *          measurement plane then grades this arm's bounce data as comparable
 *          with our own VERP stream while the bounces still land at the provider.
 *  - `no`  the transport owns the envelope sender. The fail-closed default.
 *
 * THE CORE VOCABULARY'S THIRD VALUE, `probe`, IS NOT AVAILABLE HERE, and its
 * absence is the contract: a probe verdict is evidence from a real send that
 * carried a signed VERP local part, which needs `sendReturnPathProbe` on the
 * adapter — a wire the plugin transport contract does not have (see
 * `createHostedSendProvider` in `apps/api/convex/lib/sendProviders/pluginProvider.ts`,
 * which never populates it). A plugin kind declaring `probe` would be settled
 * `unsupported` without a send anyway, so the type refuses the word instead of
 * letting an author write a capability that cannot be proven.
 */
export type PluginSendTransportCustomReturnPathSupport = 'yes' | 'no';

/**
 * Where the provider message id this transport reports comes from — the
 * catalog's `messageIdSource`, as a plugin may declare it.
 *
 *  - `provider` the transport mints the id and returns it from `send`. The
 *               fail-closed default.
 *  - `composed` the transport echoes back the RFC 5322 `Message-ID` the composer
 *               already minted, which is what an SMTP-speaking relay does.
 *
 * `idempotency-key` — the id the host derives BEFORE the network crossing — is
 * deliberately not offered. It turns on a pre-dispatch identity binding that is
 * still MTA-shaped; the canonical list of what generalizing it costs is the
 * PREREQUISITES note on `AcceptanceSemantics` in
 * `packages/shared/src/sendProviderCatalogTypes.ts`, and it is backend work no
 * manifest can do. The host re-refuses it at composition time for the same
 * reason it re-refuses `acceptanceSemantics: 'accepted'`, which for the same
 * reason cannot be declared here either: the only value available to this tier
 * is the fail-closed default the catalog already applies, so there is nothing
 * to write.
 */
export type PluginSendTransportMessageIdSource = 'provider' | 'composed';

/**
 * Data-only manifest descriptor. Executable code lives at `module.exportPath`.
 *
 * CAPABILITY PARITY (the seams plan's D4/P3.1). The fields below are the catalog
 * entry's own vocabulary, spelled identically, because a plugin kind is meant to
 * be indistinguishable from a core kind to routing, dispatch, ramp and
 * measurement. Every one is optional and every one has the SAME fail-closed
 * default a core entry that omitted it would get, so a manifest written against
 * the older contract composes exactly as it did.
 *
 * WHAT A PLUGIN STILL CANNOT DECLARE, and why — each is a promise whose other
 * half lives outside a manifest:
 *
 *  - `domainVerification: 'api'` needs a registered sending-domain provider
 *    (`domainIdentity` module export — the seams plan's P3.2).
 *  - `hasProviderFeedback` is DERIVED, not declared: it is true exactly when
 *    {@link PluginSendTransportDefinition.webhook} is present, which is the same
 *    fact stated once. A boolean beside it could only ever disagree.
 *  - `tagsFeedbackProvenance` says our own MTA stamped the report on its way out
 *    of our own infrastructure. It is never true of a third party.
 *  - `setupProbe` names an exported validator in `@owlat/shared/setupValidators`,
 *    which is host code a manifest cannot add to.
 *  - `credentialFields` describes a form no surface renders for this tier yet;
 *    declaring one would be a bucket with no consumer, which the platform's own
 *    honesty gate exists to prevent.
 */
export interface PluginSendTransportDefinition {
	readonly id: PluginLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Host-owned delays after retryable failures; at most three bounded entries. */
	readonly retryDelays: readonly number[];
	/**
	 * The deployment variables THIS TRANSPORT's own configuration lives in — the
	 * catalog entry's `requiredEnvVars`, and the credentials the host resolves per
	 * INSTANCE and hands to {@link PluginSendTransportModule.send} as
	 * {@link PluginSendTransportConfig}.
	 *
	 * Declaring them is what makes named instances possible for a plugin kind
	 * (`plugin.<id>.<local>#eu`, reading `PLUGIN_ACME_TOKEN__EU`): the host can
	 * only resolve a per-instance credential set for variables it was told about.
	 * A transport that declares none keeps the shipped behaviour exactly — its
	 * presence gate stays the plugin's `flag.requiredEnvVars` and a named instance
	 * of it is refused `instances_unsupported`, because there would be nothing
	 * instance-scoped to read and the send would go out on the DEFAULT instance's
	 * credentials.
	 *
	 * `PLUGIN_`-PREFIXED, like every other manifest-declared variable whose VALUE
	 * the host reads (a settings `secret`, a webhook signing key). The prefix is
	 * the namespace that keeps a manifest from naming — and being handed —
	 * `MTA_API_KEY` or `AWS_SECRET_ACCESS_KEY`. A name containing `__` is refused
	 * too: the instance suffix separator is `__`, so `PLUGIN_A__EU` as a BASE name
	 * would let the default instance read the `eu` instance's credential.
	 */
	readonly requiredEnvVars?: readonly string[];
	/**
	 * Variables the transport READS but does not need — refinements with a safe
	 * default. Resolved and handed over exactly like the required ones (and under
	 * the same naming rules), but absent from the presence gate, so a deployment
	 * that never set one still counts as configured.
	 */
	readonly optionalEnvVars?: readonly string[];
	/** Declared envelope-sender control. Absent ⇒ `no` (fail closed). */
	readonly supportsCustomReturnPath?: PluginSendTransportCustomReturnPathSupport;
	/** Where the reported message id comes from. Absent ⇒ `provider` (fail closed). */
	readonly messageIdSource?: PluginSendTransportMessageIdSource;
	/**
	 * May the same request be sent twice under one idempotency key without
	 * delivering twice? Absent ⇒ `false` (fail closed).
	 *
	 * Its consumer is the system/auth mail path, which asks whether an ambiguous
	 * password reset may be sent again. A transport declaring `true` MUST also
	 * implement {@link PluginSendTransportModule.buildSystemMailExtras} and carry
	 * the key into its request — the host refuses the composition otherwise,
	 * because a declaration without the wiring turns a double delivery into a
	 * "safe" retry.
	 */
	readonly deduplicatesOnIdempotencyKey?: boolean;
	/**
	 * Optional feedback webhook. AT MOST ONE send transport per plugin may
	 * declare one, because the route surface is keyed by plugin id
	 * (`/webhooks/plugin/<pluginId>`) and a second declaration would have no way
	 * to be addressed.
	 *
	 * Declaring one IS the catalog's `hasProviderFeedback: true` for this kind —
	 * see the note on {@link PluginSendTransportDefinition}.
	 */
	readonly webhook?: PluginSendTransportWebhookDefinition;
}

/**
 * The most configuration variables one bundled transport may declare.
 *
 * Bounded because the host RESOLVES every one of them on every send: a manifest
 * that listed thousands would turn each attempt into that many environment reads
 * before a byte goes on the wire. Twelve is well past what a real ESP asks for
 * (the widest core kind, the generic SMTP relay, declares five).
 */
export const PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS = 12;

/** Longest configuration variable name a transport may declare. */
export const PLUGIN_SEND_TRANSPORT_MAX_ENV_VAR_LENGTH = 96;

/**
 * `PLUGIN_`-prefixed, uppercase, and containing NO `__`.
 *
 * The prefix is the namespace that keeps a manifest from naming — and the host
 * from handing over — a variable that is not the plugin's to read; it is the same
 * rule a settings `secret` and a webhook signing key already follow, for the same
 * reason (the host reads the VALUE, not just the presence).
 *
 * The `__` exclusion is the instance-suffix rule: a named instance reads
 * `<BASE>__<INSTANCEKEY>`, so a BASE name containing the separator would make
 * `PLUGIN_ACME_TOKEN__EU` addressable both as the `eu` instance's credential and
 * as some other transport's default one — two transport ids sharing one
 * credential set, which is exactly what instance resolution refuses everywhere
 * else.
 */
const TRANSPORT_ENV_VAR = /^PLUGIN_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * Whether a value names a configuration variable a bundled send transport is
 * allowed to declare (and therefore be handed the value of).
 *
 * Declared beside the contract and shared by everyone who upholds it: the
 * manifest validator refuses a bad name at authoring time, and the host
 * re-asserts it when it loads a generated artifact — because an artifact is
 * exactly where the validator's guarantee may no longer hold (a hand edit, a bad
 * merge, a partial regeneration, or a manifest validated by an older kit).
 */
export function isPluginSendTransportEnvVar(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= PLUGIN_SEND_TRANSPORT_MAX_ENV_VAR_LENGTH &&
		TRANSPORT_ENV_VAR.test(value)
	);
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
 * THIS TRANSPORT INSTANCE's resolved configuration, handed to every `send`.
 *
 * The host resolves it from {@link PluginSendTransportDefinition.requiredEnvVars}
 * and {@link PluginSendTransportDefinition.optionalEnvVars} for the instance the
 * send was addressed to, and hands over NOTHING ELSE — not the rest of the
 * deployment's environment, and not a variable this transport never declared.
 *
 * Read your credentials from here rather than from `process.env`. A module that
 * reads the environment directly reads the DEPLOYMENT-DEFAULT instance's
 * variables no matter which transport id the send was addressed to, so
 * `plugin.acme.postmark#eu` would send with the default instance's token — the
 * silent credential borrow named-instance resolution exists to prevent.
 */
export interface PluginSendTransportConfig {
	/** `null` for the deployment-default instance; the instance key otherwise. */
	readonly instanceKey: string | null;
	/**
	 * Declared variables' values, keyed by their BASE name — the name as the
	 * manifest wrote it, never the `__<INSTANCEKEY>`-suffixed one, so a module
	 * reads `env['PLUGIN_ACME_TOKEN']` for every instance. A required variable is
	 * always present (the host fails the attempt before calling `send` otherwise);
	 * an optional one is present only when the deployment set it.
	 */
	readonly env: Readonly<Record<string, string>>;
}

/**
 * The facts the host knows about ONE GOVERNED SEND, offered to
 * {@link PluginSendTransportModule.buildDispatchExtras} so the MODULE decides
 * which of them become its own extras (the seams plan's P0.1 seam, at the plugin
 * tier).
 *
 * DELIBERATELY NARROWER than the host's own dispatch input. The governance
 * identities on that input — the work-attempt id, the re-entry snapshot handle
 * and the routing lease — are capability handles the backend authenticates
 * itself with, and a transport has no send to make with them. What is here is
 * what a relay could act on.
 */
export interface PluginSendDispatchContext {
	/** The stable per-Send idempotency key, derived from the durable Send row. */
	readonly idempotencyKey: string;
	/** The governed message class this send belongs to. */
	readonly messageType: string;
	/** Which delivery domain of ours the message goes out under. */
	readonly deliveryDomain: string;
	/** The IP pool the resolved route names, when it named one. */
	readonly ipPool?: string;
	/** Whether the resolved route permits sending over the warm-up cap. */
	readonly warmupOverflowEnabled?: boolean;
	/** Normalized recipient engagement (0–100); absent for an unscored recipient. */
	readonly engagementScore?: number;
	/**
	 * The return-path host to stamp as the VERP envelope sender on this send.
	 * Present only for a transport that declared
	 * `supportsCustomReturnPath: 'yes'` AND whose From domain authorises it.
	 */
	readonly returnPathHost?: string;
}

/**
 * The same question for SYSTEM/AUTH mail (password resets, invitations, double
 * opt-in), which has no durable Send row and therefore none of the governance
 * facts above — just the caller's idempotency key, and only when it had one.
 */
export interface PluginSendSystemMailContext {
	readonly idempotencyKey?: string;
}

/**
 * Executable Node module exported by a bundled plugin.
 *
 * `parseExtras` is the sole unknown-input boundary and must either return the
 * transport's honest extras type or throw. `send` performs exactly one network
 * attempt; Owlat owns authorization, retries, health, and audit.
 *
 * THE TWO BUILDERS ARE PURE AND SYNCHRONOUS BY CONTRACT — no I/O, no clock, no
 * environment. Every fact they may need is on their input, resolved once by the
 * host, so the hot send path grows no round trip per message. What they return
 * goes back through `parseExtras` before `send` sees it: a module's own output is
 * re-validated at the same boundary a host-supplied value is, which is what keeps
 * "extras are whatever `parseExtras` accepted" true of every send.
 */
export interface PluginSendTransportModule<Extras = unknown> {
	parseExtras(input: unknown): Extras;
	send(
		params: PluginSendTransportParams,
		extras: Extras,
		config: PluginSendTransportConfig
	): Promise<PluginSendAttempt>;
	/** Turn one governed send's facts into this transport's extras. */
	buildDispatchExtras?(context: PluginSendDispatchContext): unknown;
	/**
	 * The system/auth mail path's extras. REQUIRED of a transport whose manifest
	 * declares `deduplicatesOnIdempotencyKey: true` — that is the half of the
	 * promise that carries the key into the request.
	 */
	buildSystemMailExtras?(context: PluginSendSystemMailContext): unknown;
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
