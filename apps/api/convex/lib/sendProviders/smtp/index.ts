'use node';

/**
 * Generic SMTP-relay Send provider adapter (module).
 *
 * Per ADR-0020. The long-tail transport: any provider that speaks SMTP
 * submission (Mailgun, Postmark, SendGrid, Brevo, or a self-run relay) plugs in
 * here by host/port/TLS/username/password — no per-provider API adapter. A
 * single nodemailer transport is built lazily from the instance-level
 * `SMTP_RELAY_*` env config and cached across sends on the warm worker.
 *
 * Single-attempt `sendEmail`; the **Send dispatch (helper)** owns the retry
 * loop and consumes `retryDelays` + `categorizeError`. This module runs on the
 * `'use node'` delivery worker (`delivery/worker.ts`) where nodemailer's raw
 * TCP/TLS sockets are available.
 *
 * Deliverability note: with a relay the outbound IPs belong to the relay
 * provider, so SPF/DKIM authentication is the relay's domain setup — not the
 * built-in MTA's DNS bundle. See the relay note in `domains/spf.ts`; the
 * operator-facing UX lands in the Sending-transport settings surface (a4).
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getBoolean, getOptional, getRequired } from '../../env';
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	type EmailSendAttempt,
	type EmailSendParams,
	type SendProviderModule,
	type SmtpExtras,
} from '../types';
import { RETRY_DELAYS_MS } from '../../constants';

/**
 * Upper bound on a single relay send. As with SES, a generic SMTP relay has no
 * idempotency surface — once the message is on the wire a timeout is AMBIGUOUS
 * (the relay may already have accepted and queued it), so such a timeout is
 * TERMINAL rather than retryable to avoid a double-delivery. Definite
 * pre-acceptance failures (connection refused, DNS) stay retryable via
 * `categorizeError`.
 */
const SMTP_SEND_TIMEOUT_MS = 30_000;
const SMTP_SEND_TIMEOUT_MESSAGE = 'SMTP relay send timed out';

/** Default submission port when `SMTP_RELAY_PORT` is unset (STARTTLS on 587). */
const DEFAULT_SMTP_PORT = 587;

/**
 * Bound the pre-acceptance phase (TCP connect + server greeting) well under
 * `SMTP_SEND_TIMEOUT_MS` so an unreachable relay fails as a nodemailer `CONN`
 * error — which is retryable (nothing reached the wire) — rather than tripping
 * the ambiguous outer `withTimeout` that has to be treated as terminal.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 15_000;

let cachedTransport: Transporter | null = null;

/** Resolved, non-secret transport inputs (env-derived). */
export interface RelayTransportInput {
	host: string;
	port: number;
	/** true ⇒ implicit TLS (465); false ⇒ STARTTLS upgrade (587). */
	secure: boolean;
	user: string;
	pass: string;
}

/**
 * Assemble the nodemailer transport options for a relay send. Pure and exported
 * so the TLS floor and STARTTLS-enforcement invariants are pinned by a test
 * rather than living only inside the network path.
 *
 * - `requireTLS: !secure` — on the STARTTLS path demand the upgrade so a relay
 *   that omits STARTTLS (or a MITM stripping it) can't silently downgrade the
 *   AUTH credentials + body to cleartext.
 * - `tls.minVersion: 'TLSv1.2'` — pin the floor (RFC 8996 deprecates TLS 1.0/1.1,
 *   RFC 9325 mandates 1.2+). The direct-MX pool already pins this; without it the
 *   relay path's floor was Node's env-fragile process default.
 */
export function buildRelayTransportOptions(input: RelayTransportInput) {
	return {
		host: input.host,
		port: input.port,
		secure: input.secure,
		requireTLS: !input.secure,
		// Fail a merely-unreachable relay fast and retryably (see the constant).
		connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
		greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
		tls: { minVersion: 'TLSv1.2' as const },
		auth: { user: input.user, pass: input.pass },
	};
}

/**
 * Build (once) the nodemailer transport from the instance-level relay config.
 * `secure: true` opens an implicit TLS connection (typically port 465);
 * `secure: false` connects in cleartext and upgrades via STARTTLS (587). Auth
 * credentials are required — this deployment authenticates to the relay.
 */
function getTransport(): Transporter {
	if (cachedTransport) return cachedTransport;
	const host = getRequired('SMTP_RELAY_HOST');
	const portRaw = getOptional('SMTP_RELAY_PORT');
	const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_SMTP_PORT;
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(`Invalid SMTP_RELAY_PORT: ${portRaw}`);
	}
	const secure = getBoolean('SMTP_RELAY_SECURE');
	cachedTransport = nodemailer.createTransport(
		buildRelayTransportOptions({
			host,
			port,
			secure,
			user: getRequired('SMTP_RELAY_USERNAME'),
			pass: getRequired('SMTP_RELAY_PASSWORD'),
		})
	);
	return cachedTransport;
}

/**
 * Does this error look like a timeout (the outer `withTimeout` sentinel, a
 * socket-level `ETIMEDOUT`, or "timed out" wording)? Timeout classification is
 * only AMBIGUOUS when no SMTP reply arrived — see `classifySmtpError`.
 */
function isTimeoutError(code: string | undefined, message: string): boolean {
	if (message === SMTP_SEND_TIMEOUT_MESSAGE) return true;
	const upperCode = (code ?? '').toUpperCase();
	if (upperCode === 'ETIMEDOUT') return true;
	const lower = message.toLowerCase();
	return lower.includes('timed out') || lower.includes('timeout');
}

/**
 * Does this error represent a mid-session TCP/TLS connection loss (as opposed to
 * an SMTP-level rejection)? Matched by nodemailer's `ESOCKET`/`ECONNECTION`
 * codes and the "connection closed" / "socket hang up" wording.
 */
function isConnectionLoss(code: string | undefined, message: string): boolean {
	const upperCode = (code ?? '').toUpperCase();
	if (upperCode === 'ESOCKET' || upperCode === 'ECONNECTION') return true;
	const lower = message.toLowerCase();
	return lower.includes('connection closed') || lower.includes('socket hang up');
}

/**
 * Catch-side classification for a nodemailer send failure. Pure and exported so
 * the branch logic (which decides retry vs. terminal, and — critically — which
 * failures are double-delivery-ambiguous) is pinned by table-driven tests
 * rather than living only inside the network path.
 *
 * Order matters:
 *  1. `command === 'CONN'` — TCP connect / greeting failure (incl. the
 *     connection/greeting timeouts). Nothing reached the wire ⇒ retryable.
 *  2. A timeout is AMBIGUOUS only when NO SMTP reply arrived
 *     (`responseCode === undefined`). A numeric reply code is the server's
 *     definitive verdict — even a `421 4.4.2 Error: timeout exceeded` means the
 *     message was rejected, not accepted — so it falls through to the reply-code
 *     path and is classified as the retryable/permanent code it deserves.
 *  3. A `command === 'DATA'` connection loss is AMBIGUOUS: the final dot may
 *     have been sent and the `250` lost — the same on-the-wire ambiguity a
 *     post-dispatch timeout carries. Connection losses at EHLO/MAIL/RCPT stay
 *     retryable because the server discards an incomplete transaction.
 *  4. Everything else falls back to the reply-code + message-text taxonomy.
 */
export function classifySmtpError(input: {
	code?: string;
	command?: string;
	responseCode?: number;
	message: string;
}): EmailErrorCode {
	const { code, command, responseCode, message } = input;

	if (command === 'CONN') {
		return EmailErrorCode.SERVER_ERROR;
	}

	if (responseCode === undefined && isTimeoutError(code, message)) {
		return EmailErrorCode.AMBIGUOUS_TIMEOUT;
	}

	if (command === 'DATA' && responseCode === undefined && isConnectionLoss(code, message)) {
		return EmailErrorCode.AMBIGUOUS_TIMEOUT;
	}

	return categorizeSmtpError(`${code ?? ''}: ${message}`, responseCode);
}

/**
 * Does the (lowercased) error/reply text name a rate-limit / throttling
 * condition? Single matcher shared by both the reply-code path
 * (`smtpReplyCodeToErrorCode`) and the text-fallback path (`categorizeError`)
 * so a 4xx "rate exceeded" classifies identically no matter which reaches it.
 */
function mentionsRateLimit(lowerMessage: string): boolean {
	return (
		lowerMessage.includes('rate limit') ||
		lowerMessage.includes('rate-limit') ||
		lowerMessage.includes('too many') ||
		lowerMessage.includes('throttl')
	);
}

export const smtpSendProvider: SendProviderModule<'smtp'> = {
	kind: 'smtp',
	retryDelays: RETRY_DELAYS_MS,

	async sendEmail(params: EmailSendParams, _extras?: SmtpExtras): Promise<EmailSendAttempt> {
		let transport: Transporter;
		try {
			transport = getTransport();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		try {
			const info = await withTimeout(
				transport.sendMail({
					from: params.from,
					to: params.to,
					subject: params.subject,
					html: params.html,
					text: params.text,
					replyTo: params.replyTo,
					headers:
						params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined,
					attachments: params.attachments?.map((a) => ({
						filename: a.filename,
						content: a.content,
						contentType: a.contentType,
					})),
				}),
				SMTP_SEND_TIMEOUT_MS,
				SMTP_SEND_TIMEOUT_MESSAGE
			);

			return { success: true, id: info.messageId };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			// nodemailer errors carry a string `code` (e.g. `EAUTH`, `ECONNECTION`)
			// and, for SMTP-level rejections, a numeric `responseCode` (the reply
			// code). Pull both off defensively — they are untyped on the base Error.
			const errorObj = error as { code?: unknown; responseCode?: unknown; command?: unknown };
			const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
			const command = typeof errorObj.command === 'string' ? errorObj.command : undefined;
			const responseCode =
				typeof errorObj.responseCode === 'number' ? errorObj.responseCode : undefined;

			return {
				success: false,
				errorMessage,
				errorCode: classifySmtpError({ code, command, responseCode, message: errorMessage }),
			};
		}
	},

	categorizeError(message: string, smtpReplyCode?: number): EmailErrorCode {
		return categorizeSmtpError(message, smtpReplyCode);
	},
};

/**
 * Classify an SMTP-relay failure from its message text (and optional reply
 * code). When a numeric SMTP reply code is present it is authoritative (note:
 * unlike HTTP, an SMTP 5xx is a PERMANENT reject, not a retryable server error —
 * so this maps reply codes directly rather than through the shared
 * `httpStatusToErrorCode`). Otherwise it falls back to nodemailer's string
 * `code` + message text. Kept standalone (and reused by `classifySmtpError`) so
 * both the module method and the catch-side classifier share one taxonomy.
 */
export function categorizeSmtpError(message: string, smtpReplyCode?: number): EmailErrorCode {
	if (smtpReplyCode !== undefined) {
		const byCode = smtpReplyCodeToErrorCode(smtpReplyCode, message);
		if (byCode !== undefined) return byCode;
	}

	const lower = message.toLowerCase();

	// Rate limiting is usually surfaced as a 4xx with wording, before a reply
	// code is parsed — catch it by text too.
	if (mentionsRateLimit(lower)) {
		return EmailErrorCode.RATE_LIMIT;
	}
	// nodemailer transport/connection failures — never reached acceptance, so
	// safe to retry.
	if (
		lower.includes('econnection') ||
		lower.includes('econnrefused') ||
		lower.includes('esocket') ||
		lower.includes('edns') ||
		lower.includes('connection refused') ||
		lower.includes('greeting never received') ||
		lower.includes('connection closed')
	) {
		return EmailErrorCode.SERVER_ERROR;
	}
	if (
		lower.includes('eauth') ||
		lower.includes('authentication') ||
		lower.includes('invalid login')
	) {
		return EmailErrorCode.AUTH_FAILED;
	}
	if (lower.includes('emessage') || lower.includes('spam') || lower.includes('blocked')) {
		return EmailErrorCode.CONTENT_REJECTED;
	}
	if (
		lower.includes('eenvelope') ||
		lower.includes('no recipients') ||
		lower.includes('invalid recipient')
	) {
		return EmailErrorCode.INVALID_RECIPIENT;
	}

	return EmailErrorCode.UNKNOWN;
}

/**
 * Map a raw SMTP reply code (RFC 5321 §4.2) to the typed error taxonomy.
 * 4xx are transient (retryable); 5xx are permanent, further split by the
 * specific enhanced reason. Returns `undefined` for codes with no definitive
 * classification so the caller falls back to message parsing.
 */
export function smtpReplyCodeToErrorCode(
	code: number,
	message: string
): EmailErrorCode | undefined {
	const lower = message.toLowerCase();

	// 4xx — transient. 421/450/451/452 mean "try again later"; classify as a
	// retryable server error, unless the text names a rate limit.
	if (code >= 400 && code < 500) {
		if (mentionsRateLimit(lower)) {
			return EmailErrorCode.RATE_LIMIT;
		}
		return EmailErrorCode.SERVER_ERROR;
	}

	if (code >= 500 && code < 600) {
		// 530/534/535/538 — authentication required / failed.
		if (code === 530 || code === 534 || code === 535 || code === 538) {
			return EmailErrorCode.AUTH_FAILED;
		}
		// 552 (message too large / storage) and 554 (transaction failed — often a
		// spam/policy reject) are content problems.
		if (code === 552 || code === 554) {
			return EmailErrorCode.CONTENT_REJECTED;
		}
		// 550/551/553 — mailbox unavailable / user not local / bad address.
		if (code === 550 || code === 551 || code === 553) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}
		return EmailErrorCode.CONTENT_REJECTED;
	}

	return undefined;
}
