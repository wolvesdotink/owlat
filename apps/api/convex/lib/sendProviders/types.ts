/**
 * Send provider adapter (module) — shared types.
 *
 * Per ADR-0020 — the per-provider Send-side surface. Four adapters today:
 * `mta`, `ses`, `resend`, `smtp`. The **Send dispatch (helper)** in
 * `./dispatch.ts` owns the retry loop and post-attempt orchestration;
 * per-provider modules own single-attempt sends and per-provider error
 * categorization.
 *
 * See CONTEXT.md "Send provider adapter (module)".
 */

import { getOptional } from '../env';
import { isSendProviderKind, type SendProviderKind } from './catalog';

/**
 * The provider kinds, as a runtime tuple so both the `SendProviderKind` type
 * and the `isSendProviderKind` guard derive from one source. The canonical list
 * lives in `@owlat/shared` (`SEND_TRANSPORT_KINDS`) — the SAME tuple the outbound
 * DMARC-alignment guard keys off — and is re-exported here so a new provider kind
 * can't be added on either side without the other seeing it. This re-export lives
 * in this pure, isolate-safe module (no `'use node'` deps) so the isolate
 * function modules that only need the guard — `delivery/enqueue.ts`,
 * `delivery/status.ts`, `routing.ts`, `capability.ts` — can import it without
 * pulling the `SEND_PROVIDERS` registry (and thus the node-only `@owlat/smtp-client`)
 * into a non-`'use node'` bundle.
 */
export { SEND_PROVIDER_KINDS, isSendProviderKind } from './catalog';
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
	/** Callback material whose canonical digest is authenticated by the token. */
	routingReentry?: {
		envelopeInput: unknown;
		retryState: { attempt: number; startedAt: number; idempotencyKey: string };
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
 * A generic SMTP relay has no per-send provider knobs — the connection
 * (host/port/TLS/auth) is instance-level config, not per-message.
 */
export type SmtpExtras = Record<string, never>;

export type ExtrasFor<K extends SendProviderKind> = K extends 'mta'
	? MtaExtras
	: K extends 'ses'
		? SesExtras
		: K extends 'resend'
			? ResendExtras
			: K extends 'smtp'
				? SmtpExtras
				: unknown;

// ─── Single-attempt result ─────────────────────────────────────────────────

export enum EmailErrorCode {
	/** Rate limit exceeded — retryable */
	RATE_LIMIT = 'RATE_LIMIT',
	/** Temporary server error — retryable */
	SERVER_ERROR = 'SERVER_ERROR',
	/** Invalid recipient — not retryable */
	INVALID_RECIPIENT = 'INVALID_RECIPIENT',
	/** Invalid sender domain — not retryable */
	INVALID_SENDER = 'INVALID_SENDER',
	/** Authentication failed — not retryable */
	AUTH_FAILED = 'AUTH_FAILED',
	/** Content rejected (spam, etc.) — not retryable */
	CONTENT_REJECTED = 'CONTENT_REJECTED',
	/**
	 * The send request timed out AFTER it was put on the wire, so it is
	 * ambiguous whether the provider already accepted (and delivered) it.
	 * NOT retryable: on a provider with no server-side dedup (SES), a retry
	 * of an already-accepted request would double-deliver. Used only where a
	 * surviving retry cannot be de-duped at the provider (see the SES adapter;
	 * MTA/Resend instead thread an idempotency key and stay retryable).
	 */
	AMBIGUOUS_TIMEOUT = 'AMBIGUOUS_TIMEOUT',
	/**
	 * The envelope carries a non-ASCII (RFC 6531 SMTPUTF8 / EAI) mailbox but the
	 * destination server did not advertise `SMTPUTF8`. There is no ASCII downgrade
	 * for a UTF-8 local-part, so the client fails closed rather than mangling the
	 * address — a permanent, NOT-retryable condition distinct from a generic
	 * server error.
	 */
	SMTPUTF8_UNSUPPORTED = 'SMTPUTF8_UNSUPPORTED',
	/** A last-mile safety lease changed; reschedule with a fresh decision. */
	ROUTING_DEFERRED = 'ROUTING_DEFERRED',
	/** Unknown error */
	UNKNOWN = 'UNKNOWN',
}

export type EmailSendAttempt =
	| { success: true; id: string }
	| {
			success: false;
			errorMessage: string;
			errorCode: EmailErrorCode;
			retryAfterMs?: number;
	  };

// ─── Dispatch helper result ────────────────────────────────────────────────

export interface DispatchResult {
	/** Final attempt outcome. */
	result: EmailSendAttempt;
	/** Which provider was used (for downstream observability). */
	providerType: SendProviderKind;
	/** Total elapsed across all attempts. */
	latencyMs: number;
	/** Number of attempts including retries. */
	attempts: number;
}

// ─── Adapter interface ─────────────────────────────────────────────────────

export interface SendProviderModule<K extends SendProviderKind> {
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
	 */
	sendEmail(params: EmailSendParams, extras?: ExtrasFor<K>): Promise<EmailSendAttempt>;

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

/**
 * Map a transport-level HTTP status to a typed `EmailErrorCode`, or
 * `undefined` when the status carries no definitive classification (the
 * caller then falls back to provider-specific message parsing).
 *
 * Shared status → code prelude across the MTA/SES/Resend `categorizeError`
 * methods: `429 → RATE_LIMIT`, `5xx → SERVER_ERROR`, `401/403 → AUTH_FAILED`.
 * Only providers that surface an HTTP status (the MTA today) reach the
 * 401/403 branch; SES/Resend never pass a status, so this only folds the
 * shared prelude and leaves each provider's own error parsing intact.
 */
export function httpStatusToErrorCode(status: number): EmailErrorCode | undefined {
	if (status === 429) return EmailErrorCode.RATE_LIMIT;
	if (status >= 500) return EmailErrorCode.SERVER_ERROR;
	if (status === 401 || status === 403) return EmailErrorCode.AUTH_FAILED;
	return undefined;
}

/**
 * Retry predicate over the typed error code. The dispatch helper retries
 * on `RATE_LIMIT` and `SERVER_ERROR`; everything else is terminal.
 */
export function isRetryableErrorCode(code: EmailErrorCode): boolean {
	return code === EmailErrorCode.RATE_LIMIT || code === EmailErrorCode.SERVER_ERROR;
}
