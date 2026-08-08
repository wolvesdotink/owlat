/**
 * Send provider adapter (module) — shared types.
 *
 * Per ADR-0020 — the per-provider Send-side surface. Five adapters today:
 * `mta`, `ses`, `resend`, `smtp`, `mandrill`. The **Send dispatch (helper)** in
 * `./dispatch.ts` owns the retry loop and post-attempt orchestration;
 * per-provider modules own single-attempt sends and per-provider error
 * categorization.
 *
 * See CONTEXT.md "Send provider adapter (module)".
 */

import type { DeliveryDomain, GovernedMessageType } from '@owlat/shared';
import type { MtaRoutingReentry } from '@owlat/mta-protocol/send';
import { getOptional } from '../env';
import { isSendProviderKind, type SendProviderKind } from './catalog';
import { EmailErrorCode, type EmailSendAttempt } from './errors';
import type { SystemMailExtrasCapableModule } from './systemMailExtras';
import type { SendTransportId, SendTransportRecord } from './transports';

/**
 * The provider kinds, as a runtime list so both the `SendProviderKind` type and
 * the `isSendProviderKind` guard derive from one source. That source is the
 * send-provider catalog in `@owlat/shared` (the seams plan's D1): its entries
 * are the declaration, `SEND_TRANSPORT_KINDS` is `entries.map(e => e.kind)`, and
 * the outbound DMARC-alignment guard reads the SAME derivation. Re-exported here
 * so a new provider kind can't be added on either side without the other seeing
 * it. This re-export lives
 * in this pure, isolate-safe module (no `'use node'` deps) so the isolate
 * function modules that only need the guard — `delivery/enqueue.ts`,
 * `delivery/status.ts`, `routing.ts`, `capability.ts` — can import it without
 * pulling the `SEND_PROVIDERS` registry (and thus the node-only `@owlat/smtp-client`)
 * into a non-`'use node'` bundle.
 */
export { SEND_PROVIDER_KINDS, isSendProviderKind } from './catalog';
export { EmailErrorCode, httpStatusToErrorCode, isRetryableErrorCode } from './errors';
export type { EmailSendAttempt } from './errors';
export type { SystemMailExtrasInput, SystemMailExtrasCapableModule } from './systemMailExtras';
export type { CoreSendProviderKind, SendProviderKind } from './catalog';

/**
 * Select the provider kind the worker will dispatch through.
 *
 * An explicitly supplied provider is authoritative: a stale or invalid value
 * fails closed instead of borrowing the deployment-wide EMAIL_PROVIDER. The
 * environment fallback is used only when the producer supplied no provider.
 */
export function selectSendProviderKind(
	explicitProviderType: string | undefined
): SendProviderKind | null {
	if (explicitProviderType !== undefined) {
		return isSendProviderKind(explicitProviderType) ? explicitProviderType : null;
	}

	const environmentProviderType = getOptional('EMAIL_PROVIDER');
	return isSendProviderKind(environmentProviderType) ? environmentProviderType : null;
}

/**
 * Canonical IP-pool names the built-in MTA routes through. Single source of
 * truth for `MtaExtras.ipPool` (below) and the `providerRoutes.listIpPools`
 * query that populates the provider-routing IP-pool autocomplete + the
 * unknown-name warning in the settings UI.
 */
export const MTA_IP_POOL_NAMES = ['transactional', 'campaign'] as const;
export type MtaIpPool = (typeof MTA_IP_POOL_NAMES)[number];

// ─── Send params (shared base, no per-provider extras) ─────────────────────

export interface EmailAttachment {
	/** Filename for the attachment */
	filename: string;
	/** Binary content of the attachment */
	content: Buffer;
	/** MIME type (defaults to application/octet-stream) */
	contentType?: string;
}

export interface EmailSendParams {
	/** Recipient email address */
	to: string;
	/** Sender email address (format: "Name <email@domain.com>" or "email@domain.com") */
	from: string;
	/** Email subject line */
	subject: string;
	/** HTML content of the email */
	html: string;
	/**
	 * Plain-text alternative (RFC 2046 §5.1.4). Built by the composer from the
	 * UNTRACKED html so the `text/plain` part is clean — not a strip of the
	 * tracked HTML. When omitted the provider derives one itself.
	 */
	text?: string;
	/** Optional reply-to email address */
	replyTo?: string;
	/** Optional custom headers */
	headers?: Record<string, string>;
	/** Optional file attachments */
	attachments?: EmailAttachment[];
}

// ─── Per-provider extras (typed second arg on `sendEmail`) ─────────────────

export interface MtaExtras {
	/** Unique message ID for correlation */
	messageId?: string;
	/** Unique identity for this bounded queue attempt. */
	workAttemptId?: string;
	/** Opaque Convex-issued server-side re-entry snapshot handle. */
	routingReentryToken?: string;
	/**
	 * Callback material whose canonical digest is authenticated by the token:
	 * the wire's {@link MtaRoutingReentry} (D7) with `retryState` narrowed to
	 * {@link DispatchReentryRetryState}. `reentryRetryState()` in
	 * `delivery/governedDispatch.ts` drops the wire's optional `workAttemptId`
	 * and `acceptanceReconciliation` so a successor mints its own work identity.
	 */
	routingReentry?: Omit<MtaRoutingReentry, 'retryState'> & {
		retryState: DispatchReentryRetryState;
	};
	/** IP pool: 'transactional' or 'campaign' (see MTA_IP_POOL_NAMES). */
	ipPool?: MtaIpPool;
	/** Engagement score 0-100 for priority ordering */
	engagementScore?: number;
	/** Domain for DKIM signing */
	dkimDomain?: string;
	organizationId?: string;
	messageType?: import('@owlat/shared').GovernedMessageType;
	deliveryDomain?: import('@owlat/shared').DeliveryDomain;
	intakePath?: 'system';
	routingLease?: string;
	/** Decision input bound into the authenticated routing lease. */
	allowWarmupOverflow?: boolean;
}

export type SesExtras = Record<string, never>;

export interface ResendExtras {
	/**
	 * Stable idempotency key. Forwarded to Resend as the `Idempotency-Key`
	 * header so a surviving retry de-dupes at Resend instead of double-sending.
	 * The governed dispatch boundary derives this from the durable Send row.
	 */
	idempotencyKey?: string;
}

/**
 * The connection (host/port/TLS/auth) is instance-level config, not
 * per-message, so a relay has almost no per-send knobs. The exception is the
 * envelope sender: where the relay honours a custom RFC5321.MailFrom we stamp
 * OUR VERP address so relayed bounces come back to our own bounce server and
 * both transport arms produce comparable bounce data (plan G-08).
 */
export interface SmtpExtras {
	/**
	 * The return-path host to stamp as the VERP envelope sender on this send.
	 *
	 * Present ONLY when the routing seam has resolved all three conditions at
	 * once: this transport's `supportsCustomReturnPath` capability is
	 * `supported`, the From domain has a return-path host (its own override, or
	 * the deployment-global one — the SAME host the direct-MX arm stamps, so the
	 * two arms present the same envelope-sender domain, D11), and that host's
	 * published SPF authorises this transport. Absent ⇒ leave the envelope
	 * sender exactly as the composer built it (the shipped behaviour) and treat
	 * the cell's bounce data as degraded — never an error, never a blocker (D2).
	 */
	returnPathHost?: string;
}

/**
 * Mailchimp Transactional (Mandrill) per-send knobs (plan D3/D5).
 *
 * Only the two facts the ROUTE decides. The subaccount is deliberately NOT here:
 * it is instance-level configuration (`MANDRILL_SUBACCOUNT`), read inside the
 * adapter, and `buildDispatchExtras` is env-free by contract — extras carry
 * routing facts, never credentials or deployment config.
 */
export interface MandrillExtras {
	/**
	 * The dedicated-IP pool name to send this message from, as the resolved
	 * route named it. Free-form, because Mandrill pool names are whatever the
	 * account created ("Main Pool", "Transactional", …) rather than a fixed set
	 * like {@link MtaIpPool}. Absent ⇒ the adapter falls back to the
	 * deployment's `MANDRILL_IP_POOL`, and failing that omits the field so
	 * Mandrill picks the account default.
	 */
	ipPool?: string;
	/**
	 * The domain to hand Mandrill as `return_path_domain`, so bounces it
	 * generates come back to OUR bounce server and this arm produces bounce data
	 * comparable with the direct-MX arm.
	 *
	 * Present ONLY when the routing pass proved the transport honours a custom
	 * return path — the catalog declares `supportsCustomReturnPath: 'probe'`, so
	 * this is the probe verdict, not an assumption (D5). Absent ⇒ leave
	 * Mandrill's own bounce domain in place and treat the cell's bounce data as
	 * degraded; never an error, never a blocker.
	 */
	returnPathDomain?: string;
}

// ─── Per-send extras, built by the module (the governed-dispatch seam) ─────

/**
 * The retry identity a routing re-entry successor inherits, exactly as the
 * governed boundary minted it. Structural — the re-entry callback digest is
 * computed over THESE THREE FIELDS, so a module that forwards it must forward
 * it unchanged rather than rebuilding it.
 */
export interface DispatchReentryRetryState {
	attempt: number;
	startedAt: number;
	idempotencyKey: string;
}

/**
 * Everything the governed dispatch boundary knows about one send, handed to the
 * provider module so the MODULE decides which of it becomes its own extras.
 *
 * Deliberately provider-agnostic and flat: each field is a fact about the
 * message or the resolved route that any transport could reasonably want (or
 * ignore) — never a pre-shaped provider payload. That is the whole point of the
 * seam: before it, `delivery/governedDispatch.ts` carried a `providerKind ===
 * 'mta' ? … : 'resend' ? …` chain, so every new provider kind had to edit the
 * governed send path to be allowed any per-send knob at all.
 *
 * The boundary resolves each fact ONCE — the routing pass already paid for it —
 * and never re-reads it per module, so `buildDispatchExtras` stays pure and
 * synchronous and the hot send path grows no round trip per message.
 */
export interface DispatchExtrasInput {
	/**
	 * The stable per-Send idempotency key, derived from the durable Send row.
	 * Also the id the MTA correlates work by (`MtaExtras.messageId`) and the
	 * `Idempotency-Key` a provider with server-side dedup is given.
	 */
	readonly idempotencyKey: string;
	/** Unique identity for this bounded queue attempt. */
	readonly workAttemptId: string;
	readonly organizationId: string;
	readonly messageType: GovernedMessageType;
	readonly deliveryDomain: DeliveryDomain;
	/** Opaque Convex-issued server-side re-entry snapshot handle. */
	readonly routingReentryToken: string;
	/** Callback material whose canonical digest is authenticated by the token. */
	readonly routingReentry: {
		envelopeInput: unknown;
		retryState: DispatchReentryRetryState;
	};
	/** The authenticated last-mile routing lease, when the route took one. */
	readonly routingLease?: string | undefined;
	/**
	 * The IP pool the resolved route names, else the one the producer requested.
	 * A free-form string here: which pool names a transport accepts (and whether
	 * it has pools at all) is the transport's own business.
	 */
	readonly ipPool?: string | undefined;
	/** Whether the resolved route permits sending over the warm-up cap. */
	readonly warmupOverflowEnabled?: boolean | undefined;
	/**
	 * Normalized recipient engagement score (0–100), or `undefined` for an
	 * unscored recipient. Absence is meaningful — see `MtaExtras.engagementScore`.
	 */
	readonly engagementScore?: number | undefined;
	/**
	 * The return-path host a relay send may stamp as its VERP envelope sender,
	 * resolved by the routing pass (plan G-08). `undefined` unless the transport
	 * is PROVEN to honour a custom return path AND the From domain's return-path
	 * host authorises it — see `SmtpExtras.returnPathHost`.
	 */
	readonly relayReturnPathHost?: string | undefined;
}

export type ExtrasFor<K extends SendProviderKind> = K extends 'mta'
	? MtaExtras
	: K extends 'ses'
		? SesExtras
		: K extends 'resend'
			? ResendExtras
			: K extends 'smtp'
				? SmtpExtras
				: K extends 'mandrill'
					? MandrillExtras
					: unknown;

// ─── Dispatch helper result ────────────────────────────────────────────────

/**
 * The extras union the dispatch boundary accepts. Dispatch is keyed by a
 * transport id (a string), so it cannot narrow extras to the kind's own shape
 * the way the old kind-keyed generic did — call sites pin their extras with
 * `satisfies MtaExtras` / `satisfies ResendExtras` instead, which is checked at
 * the site that actually builds the object.
 */
export type SendProviderExtras = ExtrasFor<SendProviderKind>;

export interface DispatchResult {
	/** Final attempt outcome. */
	result: EmailSendAttempt;
	/** Which provider kind was used (for downstream observability). */
	providerType: SendProviderKind;
	/** Which configured instance of that kind was used. */
	transportId: SendTransportId;
	/** Total elapsed across all attempts. */
	latencyMs: number;
	/** Number of attempts including retries. */
	attempts: number;
}

// ─── Return-path probe wire (the capability half of plan D5) ───────────────

/**
 * What the return-path probe needs a transport to put on the wire.
 *
 * NOT a return-path *host* the way `SmtpExtras.returnPathHost` is: the probe's
 * whole evidence mechanism is that the DSN comes back to a SIGNED VERP ADDRESS
 * whose LOCAL PART encodes the probe id. Only a transport that lets us choose
 * the entire RFC5321.MailFrom can carry that, which is why this is a separate,
 * optional method rather than a flag on the ordinary send.
 */
export interface ReturnPathProbeEnvelope {
	/** The bounce host the probe's VERP envelope sender is minted at. */
	readonly returnPathHost: string;
	/**
	 * The id the VERP token encodes — the PROBE's id, not a Send's. Deliberately
	 * not reachable from `ExtrasFor<K>`: as a public per-send knob it would let a
	 * caller decouple the VERP token from the id stored as `providerMessageId`
	 * and silently break bounce attribution for real mail.
	 */
	readonly verpMessageId: string;
}

export interface ReturnPathProbeWireOutcome {
	readonly attempt: EmailSendAttempt;
	/**
	 * The RFC5321.MailFrom actually put on the wire. Returned rather than
	 * recomputed by the caller: the VERP window rolls at UTC midnight, so a
	 * caller that rebuilt the address a moment later could record an address that
	 * differs from the one sent and misread it as a relay rewrite.
	 */
	readonly envelopeSender: string;
	readonly isVerp: boolean;
}

/**
 * The optional probe wire, shared by core and hosted (plugin) adapters.
 *
 * ABSENT MEANS "THIS TRANSPORT CANNOT CARRY A PROBE", and that is the
 * fail-closed default on purpose. A probe verdict is written against ONE
 * transport id, so evidence gathered on a different transport's wire would be
 * filed as if it were this one's — which is exactly how a relay that never
 * honours our envelope sender could inherit a `supported` verdict from the
 * deployment's SMTP relay and start stamping `return_path_domain` on real mail.
 * A kind that cannot express {@link ReturnPathProbeEnvelope} therefore declines
 * here and is settled `unsupported` / `no_envelope_control` without a send.
 */
export interface ReturnPathProbeCapableModule {
	sendReturnPathProbe?(
		transport: SendTransportRecord,
		params: EmailSendParams,
		envelope: ReturnPathProbeEnvelope
	): Promise<ReturnPathProbeWireOutcome>;
}

// ─── Adapter interface ─────────────────────────────────────────────────────

export interface SendProviderModule<K extends SendProviderKind>
	extends
		ReturnPathProbeCapableModule,
		// The system/auth mail path's per-send knobs, declared in
		// `./systemMailExtras.ts` (which also says why they live there).
		SystemMailExtrasCapableModule<ExtrasFor<K>> {
	readonly kind: K;

	/**
	 * Per-provider retry backoff schedule. The dispatch helper owns the
	 * loop; the module declares the schedule.
	 *
	 *   MTA today:    [1000, 5000]
	 *   Resend today: [1000, 5000, 30000]
	 *   SES today:    [1000, 5000, 30000]
	 */
	readonly retryDelays: readonly number[];

	/**
	 * Single-attempt send. No internal retry. Returns success with the
	 * provider's message id, or failure with the raw error message and
	 * the module's typed `EmailErrorCode`. The dispatch helper decides
	 * retry based on the code.
	 *
	 * `transport` names WHICH configured instance of this kind to send through;
	 * the adapter resolves its own credentials from it (see `../transportEnv.ts`).
	 * The record itself carries no secrets, so it is safe to pass around — the
	 * secrets stay inside the adapter.
	 */
	sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: ExtrasFor<K>
	): Promise<EmailSendAttempt>;

	/**
	 * Turn the governed dispatch facts into THIS provider's typed extras.
	 *
	 * Optional, and a returned `undefined` means the same thing as omitting the
	 * method: this send carries no extras. The governed boundary then passes the
	 * empty extras it has always passed, so a provider that wants no per-send
	 * knobs costs the send path nothing.
	 *
	 * Pure and synchronous by contract — no ctx, no env, no I/O. Every fact a
	 * provider may need is already on `input`, resolved once by the routing pass;
	 * a module that needs a NEW fact adds a field there rather than a query here.
	 */
	buildDispatchExtras?(input: DispatchExtrasInput): ExtrasFor<K> | undefined;

	/**
	 * Per-provider error-response parsing. The dispatch helper passes the raw
	 * error string + an optional transport status — an HTTP status (mta) or an
	 * SMTP reply code (smtp) — and the module returns its typed code. Each
	 * adapter interprets `statusCode` in its own transport's terms (an HTTP-only
	 * adapter routes it through `httpStatusToErrorCode`; the smtp adapter maps
	 * SMTP reply codes directly). Replaces the pre-deepening global
	 * `categorizeError` that pretended to be generic but had to know every
	 * provider's error format.
	 */
	categorizeError(message: string, statusCode?: number): EmailErrorCode;
}
