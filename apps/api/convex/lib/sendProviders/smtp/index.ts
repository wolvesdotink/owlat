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
import { getOptional, getRequired } from '../../env';
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

let cachedTransport: Transporter | null = null;

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
	const secureRaw = getOptional('SMTP_RELAY_SECURE')?.toLowerCase();
	const secure =
		secureRaw === 'true' || secureRaw === '1' || secureRaw === 'yes' || secureRaw === 'on';
	cachedTransport = nodemailer.createTransport({
		host,
		port,
		secure,
		auth: {
			user: getRequired('SMTP_RELAY_USERNAME'),
			pass: getRequired('SMTP_RELAY_PASSWORD'),
		},
	});
	return cachedTransport;
}

/**
 * Is this a timeout that happened AFTER the message may have been accepted?
 * These are TERMINAL for a generic relay because a retry cannot be de-duped and
 * would risk a second delivery (mirrors the SES adapter's stance).
 */
function isAmbiguousSmtpTimeout(code: string | undefined, message: string): boolean {
	if (message === SMTP_SEND_TIMEOUT_MESSAGE) return true;
	const upperCode = (code ?? '').toUpperCase();
	if (upperCode === 'ETIMEDOUT') return true;
	const lower = message.toLowerCase();
	return lower.includes('timed out') || lower.includes('timeout');
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
			const errorObj = error as { code?: unknown; responseCode?: unknown };
			const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
			const responseCode =
				typeof errorObj.responseCode === 'number' ? errorObj.responseCode : undefined;

			// A post-dispatch timeout is AMBIGUOUS: the relay may already have
			// accepted and queued the message. No idempotency surface ⇒ TERMINAL.
			if (isAmbiguousSmtpTimeout(code, errorMessage)) {
				return {
					success: false,
					errorMessage,
					errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
				};
			}

			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(`${code ?? ''}: ${errorMessage}`, responseCode),
			};
		}
	},

	/**
	 * Classify an SMTP-relay failure. When a numeric SMTP reply code is present
	 * it is authoritative (note: unlike HTTP, an SMTP 5xx is a PERMANENT reject,
	 * not a retryable server error — so this maps reply codes directly rather
	 * than through the shared `httpStatusToErrorCode`). Otherwise it falls back
	 * to nodemailer's string `code` + message text.
	 */
	categorizeError(message: string, smtpReplyCode?: number): EmailErrorCode {
		if (smtpReplyCode !== undefined) {
			const byCode = smtpReplyCodeToErrorCode(smtpReplyCode, message);
			if (byCode !== undefined) return byCode;
		}

		const lower = message.toLowerCase();

		// Rate limiting is usually surfaced as a 4xx with wording, before a reply
		// code is parsed — catch it by text too.
		if (
			lower.includes('rate limit') ||
			lower.includes('rate-limit') ||
			lower.includes('too many') ||
			lower.includes('throttl')
		) {
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
	},
};

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
		if (lower.includes('rate') || lower.includes('too many') || lower.includes('throttl')) {
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

// Exported for tests that need to bypass the lazy-init cache between cases.
export function _resetSmtpTransportCacheForTests(): void {
	cachedTransport = null;
}
