'use node';

/**
 * Generic SMTP-relay Send provider adapter (module).
 *
 * Per ADR-0020. The long-tail transport: any provider that speaks SMTP
 * submission (Mailgun, Postmark, SendGrid, Brevo, or a self-run relay) plugs in
 * here by host/port/TLS/username/password — no per-provider API adapter. The
 * non-secret client config is resolved lazily (once) from the instance-level
 * `SMTP_RELAY_*` env and cached across sends on the warm worker; each send
 * composes the message with `@owlat/mail-message` and delivers it with the
 * in-house `@owlat/smtp-client` (one connection per send, W3).
 *
 * Single-attempt `sendEmail`; the **Send dispatch (helper)** owns the retry
 * loop and consumes `retryDelays` + `categorizeError`. This module runs on the
 * `'use node'` delivery worker (`delivery/worker.ts`) where the client's raw
 * TCP/TLS sockets are available.
 *
 * Deliverability note: with a relay the outbound IPs belong to the relay
 * provider, so SPF/DKIM authentication is the relay's domain setup — not the
 * built-in MTA's DNS bundle. See the relay note in `domains/spf.ts`; the
 * operator-facing UX lands in the Sending-transport settings surface (a4).
 */

import { composeMessage } from '@owlat/mail-message';
import {
	isSmtpError,
	sendMessage,
	type SmtpClientRefusal,
	type SmtpPhase,
} from '@owlat/smtp-client';
import { getOptional } from '../../env';
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	type EmailSendAttempt,
	type EmailSendParams,
	type SendProviderModule,
	type SmtpExtras,
} from '../types';
import type { SendTransportRecord } from '../transports';
import { RETRY_DELAYS_MS } from '../../constants';
import { getClientConfig, type RelayClientConfig } from './config';
import { resolveRelayEnvelopeSender } from './returnPath';

// The adapter's public surface is one module: the config and return-path halves
// are internal siblings, split for size and cohesion, not a new API.
export {
	buildRelayClientConfig,
	relayEhloName,
	_resetSmtpConfigCacheForTests,
	type RelayClientConfig,
	type RelayClientInput,
} from './config';
export {
	resolveRelayEnvelopeSender,
	type RelayEnvelopeSender,
	type RelayEnvelopeSenderInput,
} from './returnPath';

/**
 * Upper bound on a single relay send. As with SES, a generic SMTP relay has no
 * idempotency surface — once the message is on the wire a timeout is AMBIGUOUS
 * (the relay may already have accepted and queued it), so such a timeout is
 * TERMINAL rather than retryable to avoid a double-delivery. Definite
 * pre-acceptance failures (connection refused, DNS, a rejected recipient) stay
 * retryable via the phase-based `classifySmtpError`.
 */
const SMTP_SEND_TIMEOUT_MS = 30_000;
const SMTP_SEND_TIMEOUT_MESSAGE = 'SMTP relay send timed out';

/**
 * Catch-side classification for a structured {@link SmtpError} from the SMTP
 * client. Pure and exported so the branch logic (which decides retry vs.
 * terminal, and — critically — which failures are double-delivery-ambiguous) is
 * pinned by table-driven tests rather than living only inside the network path.
 *
 * The rule is entirely structural — no message-text sniffing:
 *  1. A numeric `replyCode` is the server's DEFINITIVE verdict, authoritative in
 *     every phase. Even a `421 4.4.2 Error: timeout exceeded` acknowledging DATA
 *     means the message was REJECTED, not accepted — so it maps through the
 *     unchanged {@link smtpReplyCodeToErrorCode} table and is the retryable /
 *     permanent code it deserves.
 *  2. With no reply, the `phase` decides. `connect`/`greeting`/`ehlo`/`starttls`/
 *     `mail`/`rcpt` are pre-acceptance: the server discards an incomplete
 *     transaction, so they are retryable `SERVER_ERROR`. `auth` without a reply
 *     is an `AUTH_FAILED` credential/handshake problem.
 *  3. `data`/`data-final` with NO reply is the double-delivery-ambiguous region:
 *     the terminating dot may be on the wire and the `250` lost, so it is
 *     `AMBIGUOUS_TIMEOUT` and is NEVER auto-retried.
 */
export function classifySmtpError(err: {
	phase: SmtpPhase;
	replyCode?: number;
	message: string;
	clientRefusal?: SmtpClientRefusal;
}): EmailErrorCode {
	// A client-side permanent refusal (no reply code) is authoritative and distinct
	// from a server verdict: the SMTPUTF8 fail-closed can never succeed on retry, so
	// it maps to its own non-retryable code rather than the phase-`mail` default.
	if (err.clientRefusal === 'smtputf8-unavailable') {
		return EmailErrorCode.SMTPUTF8_UNSUPPORTED;
	}

	if (err.replyCode !== undefined) {
		const byCode = smtpReplyCodeToErrorCode(err.replyCode, err.message);
		if (byCode !== undefined) return byCode;
	}

	switch (err.phase) {
		case 'connect':
		case 'greeting':
		case 'ehlo':
		case 'starttls':
		case 'mail':
		case 'rcpt':
			return EmailErrorCode.SERVER_ERROR;
		case 'auth':
			return EmailErrorCode.AUTH_FAILED;
		case 'data':
		case 'data-final':
			return EmailErrorCode.AMBIGUOUS_TIMEOUT;
		default: {
			// Exhaustive over SmtpPhase; a new phase must be classified explicitly.
			const _exhaustive: never = err.phase;
			return _exhaustive;
		}
	}
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

/** Per-send knobs of the relay adapter's INTERNAL entry point. */
export interface RelaySendOptions {
	/** Has this transport's capability resolved to `supported`? */
	readonly customReturnPath: boolean;
	/**
	 * Overrides the id the VERP token encodes.
	 *
	 * The return-path PROBE is the only caller: it has no Send row, so it needs
	 * the token to encode its own probe id. Deliberately NOT part of
	 * {@link SmtpExtras} — as a public per-send knob it would let any caller
	 * decouple the VERP token from the id stored as `providerMessageId` and
	 * silently break bounce attribution for a real send.
	 */
	readonly verpMessageId?: string;
}

export interface RelaySendOutcome {
	readonly attempt: EmailSendAttempt;
	/**
	 * The RFC5321.MailFrom actually put on the wire. Returned rather than
	 * recomputed by the caller: the VERP window rolls at UTC midnight, so a
	 * caller that rebuilt the address a moment later could record an address
	 * that differs from the one sent and misread it as a relay rewrite.
	 */
	readonly envelopeSender: string;
	readonly isVerp: boolean;
}

/**
 * The relay adapter's real send. `smtpSendProvider.sendEmail` is the
 * {@link SendProviderModule} face of it; the return-path probe calls it
 * directly because it needs the envelope sender back.
 */
export async function sendViaRelay(
	transport: SendTransportRecord,
	params: EmailSendParams,
	options: RelaySendOptions
): Promise<RelaySendOutcome> {
	/** Nothing reached the wire, so no envelope sender was chosen. */
	const unsent = (attempt: EmailSendAttempt): RelaySendOutcome => ({
		attempt,
		envelopeSender: params.from,
		isVerp: false,
	});
	let config: RelayClientConfig;
	try {
		config = getClientConfig(transport);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return unsent({
			success: false,
			errorMessage,
			errorCode: EmailErrorCode.AUTH_FAILED,
		});
	}

	// Compose OUTSIDE the wire timeout: composition is pure and local (no
	// socket), so a failure here is a terminal, unambiguous local error —
	// nothing ever reached the relay.
	let composed: ReturnType<typeof composeMessage>;
	try {
		composed = composeMessage({
			from: params.from,
			to: [params.to],
			subject: params.subject,
			html: params.html,
			text: params.text,
			replyTo: params.replyTo,
			headers:
				params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined,
			attachments: params.attachments?.map((a) => ({
				filename: a.filename,
				contentType: a.contentType ?? 'application/octet-stream',
				isInline: false,
				data: a.content,
			})),
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		// A composition failure never touched the wire — classify it via the
		// text taxonomy (envelope/content wording), terminal by default.
		return unsent({
			success: false,
			errorMessage,
			errorCode: categorizeSmtpError(errorMessage),
		});
	}

	// Stamp our VERP envelope sender where the relay is PROVEN to honour it, so
	// a bounce the relay generates reaches our own bounce server and this arm
	// produces bounce data comparable with the direct-MX arm. The composed
	// bytes — From, DKIM, Message-ID, body — are identical either way (D11).
	const envelopeSender = resolveRelayEnvelopeSender({
		composedEnvelopeFrom: composed.envelope.from,
		messageId: options.verpMessageId ?? composed.messageId,
		customReturnPath: options.customReturnPath,
		returnPathDomain: getOptional('MTA_RETURN_PATH_DOMAIN'),
		verpKey: getOptional('MTA_BOUNCE_VERP_KEY'),
		now: Date.now(),
	});
	const sent = (attempt: EmailSendAttempt): RelaySendOutcome => ({
		attempt,
		envelopeSender: envelopeSender.envelopeFrom,
		isVerp: envelopeSender.isVerp,
	});

	const sendAbort = new AbortController();
	try {
		await withTimeout(
			sendMessage({
				connect: config.connect,
				auth: config.auth,
				signal: sendAbort.signal,
				envelope: {
					from: envelopeSender.envelopeFrom,
					to: composed.envelope.to,
					data: composed.raw,
				},
			}),
			SMTP_SEND_TIMEOUT_MS,
			SMTP_SEND_TIMEOUT_MESSAGE
		);

		return sent({ success: true, id: composed.messageId });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';

		// A structured SmtpError carries the protocol phase + reply code — the
		// only inputs the retry-vs-terminal decision is allowed to read.
		if (isSmtpError(error)) {
			return sent({
				success: false,
				errorMessage,
				errorCode: classifySmtpError({
					phase: error.phase,
					replyCode: error.replyCode,
					message: errorMessage,
					clientRefusal: error.clientRefusal,
				}),
			});
		}

		// Anything else escaping the send — the outer `withTimeout` sentinel, or
		// an unexpected throw — happened somewhere in the send with no structured
		// phase to prove it was pre-acceptance. The message MAY have been
		// delivered, so treat it as ambiguous and TERMINAL (never auto-retry).
		return sent({
			success: false,
			errorMessage,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
		});
	} finally {
		// Promise.race cannot cancel its losing branch. Close any live SMTP
		// socket when the outer deadline wins so the send does not continue in
		// the background and later deliver after we reported a timeout.
		sendAbort.abort();
	}
}

export const smtpSendProvider: SendProviderModule<'smtp'> = {
	kind: 'smtp',
	retryDelays: RETRY_DELAYS_MS,

	async sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: SmtpExtras
	): Promise<EmailSendAttempt> {
		return (
			await sendViaRelay(transport, params, {
				customReturnPath: extras?.customReturnPath === true,
			})
		).attempt;
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
 * `httpStatusToErrorCode`). Otherwise it falls back to the string `code` +
 * message text. Kept standalone (and consumed by the retry loop's
 * `categorizeError` + the compose-failure path) so the whole module shares one
 * taxonomy.
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
	// Transport/connection failures — never reached acceptance, so safe to retry.
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
