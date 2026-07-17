/**
 * Structured SMTP error taxonomy for the in-house SMTP client.
 *
 * Downstream classifiers (bounce classification, TLS-RPT result types, the
 * EmailErrorCode taxonomy) consume these DISCRIMINANTS — never log-line string
 * matching. Every failure the client throws carries the protocol `phase`, the
 * `secured` flag (whether the socket was under TLS when it failed), and, for
 * TLS-phase failures, a machine-readable `tlsCause`.
 */

/**
 * The protocol phase in which a failure occurred. Ordered along a single
 * connection's lifecycle. `data` covers the failure of the `DATA` command
 * itself (the intermediate 354 handshake); `data-final` covers the failure of
 * the terminating `<CRLF>.<CRLF>` — the reply that acknowledges the whole
 * message. The distinction is load-bearing: a `data`/`data-final` phase with no
 * server reply is an AMBIGUOUS_TIMEOUT and is NEVER auto-retried (a retry may
 * double-deliver).
 */
export type SmtpPhase =
	| 'connect'
	| 'greeting'
	| 'ehlo'
	| 'starttls'
	| 'auth'
	| 'mail'
	| 'rcpt'
	| 'data'
	| 'data-final';

/**
 * Machine-readable cause of a TLS-phase failure. These map directly onto
 * TLS-RPT `result-type`s and the outbound TLS classifier — no string tables.
 */
export type SmtpTlsCause =
	| 'cert-expired'
	| 'cert-host-mismatch'
	| 'cert-untrusted'
	| 'starttls-unavailable'
	| 'handshake';

/**
 * Machine-readable cause of a client-side refusal — a failure the client raises
 * BEFORE (or instead of) trusting a server verdict, so it carries no reply code.
 * Classifiers read this discriminant (never a log-line string, W7) to keep the
 * outcome permanent instead of treating a reply-less pre-DATA phase as retryable.
 *
 *  - `smtputf8-unavailable`: the envelope carries a non-ASCII (RFC 6531 EAI)
 *    mailbox but the server did not advertise `SMTPUTF8`. There is no ASCII
 *    downgrade for a non-ASCII local-part, so the client fails CLOSED rather than
 *    silently mangling the address — a permanent, non-retryable condition.
 */
export type SmtpClientRefusal = 'smtputf8-unavailable';

export interface SmtpErrorInit {
	/** Protocol phase the failure occurred in. */
	phase: SmtpPhase;
	/** Human-readable message (for logs only — never classified against). */
	message: string;
	/** Three-digit SMTP reply code, when the failure carried one. */
	replyCode?: number;
	/** RFC 3463 enhanced status code (`X.Y.Z`), when present. */
	enhancedCode?: string;
	/** Whether the socket was secured (under TLS) at the moment of failure. */
	secured: boolean;
	/** For `starttls`/handshake failures: the machine-readable TLS cause. */
	tlsCause?: SmtpTlsCause;
	/** For a client-side pre-verdict refusal (no reply code): its permanent cause. */
	clientRefusal?: SmtpClientRefusal;
	/** Underlying error, if any (preserved on the standard `cause` slot). */
	cause?: unknown;
}

/**
 * The single error type thrown by the SMTP client. All fields are read-only so
 * classifiers can trust them.
 */
export class SmtpError extends Error {
	readonly phase: SmtpPhase;
	readonly replyCode?: number;
	readonly enhancedCode?: string;
	readonly secured: boolean;
	readonly tlsCause?: SmtpTlsCause;
	readonly clientRefusal?: SmtpClientRefusal;

	constructor(init: SmtpErrorInit) {
		super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = 'SmtpError';
		this.phase = init.phase;
		this.secured = init.secured;
		if (init.replyCode !== undefined) {
			this.replyCode = init.replyCode;
		}
		if (init.enhancedCode !== undefined) {
			this.enhancedCode = init.enhancedCode;
		}
		if (init.tlsCause !== undefined) {
			this.tlsCause = init.tlsCause;
		}
		if (init.clientRefusal !== undefined) {
			this.clientRefusal = init.clientRefusal;
		}
		// Restore prototype chain for `instanceof` across transpilation targets.
		Object.setPrototypeOf(this, SmtpError.prototype);
	}
}

/** Narrowing type guard for `SmtpError`. */
export function isSmtpError(value: unknown): value is SmtpError {
	return value instanceof SmtpError;
}
