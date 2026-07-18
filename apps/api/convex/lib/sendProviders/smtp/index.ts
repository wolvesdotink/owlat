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

import os from 'node:os';
import { composeMessage } from '@owlat/mail-message';
import {
	isSmtpError,
	sendMessage,
	type AuthConfig,
	type SmtpClientRefusal,
	type SmtpConnectOptions,
	type SmtpPhase,
} from '@owlat/smtp-client';
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
 * pre-acceptance failures (connection refused, DNS, a rejected recipient) stay
 * retryable via the phase-based `classifySmtpError`.
 */
const SMTP_SEND_TIMEOUT_MS = 30_000;
const SMTP_SEND_TIMEOUT_MESSAGE = 'SMTP relay send timed out';

/** Default submission port when `SMTP_RELAY_PORT` is unset (STARTTLS on 587). */
const DEFAULT_SMTP_PORT = 587;

/**
 * Bound the pre-acceptance phase (TCP connect + server greeting) well under
 * `SMTP_SEND_TIMEOUT_MS` so an unreachable relay fails in a pre-wire phase
 * (`connect`/`greeting`) — which is retryable (nothing reached the wire) —
 * rather than tripping the ambiguous outer `withTimeout` that has to be treated
 * as terminal.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 15_000;

/** Resolved, non-secret relay client config: how to connect + how to AUTH. */
export interface RelayClientConfig {
	connect: SmtpConnectOptions;
	auth: AuthConfig;
}

let cachedConfig: RelayClientConfig | null = null;

/** Resolved, non-secret relay client inputs (env-derived). */
export interface RelayClientInput {
	host: string;
	port: number;
	/** true ⇒ implicit TLS (465); false ⇒ STARTTLS upgrade (587). */
	secure: boolean;
	user: string;
	pass: string;
	/** EHLO identity announced to the relay. */
	ehloName: string;
}

/**
 * Assemble the in-house SMTP-client config for a relay send. Pure and exported
 * so the TLS floor and STARTTLS-enforcement invariants are pinned by a test
 * rather than living only inside the network path.
 *
 * - `requireTls: !secure` — on the STARTTLS path demand the upgrade so a relay
 *   that omits STARTTLS (or a MITM stripping it) can't silently downgrade the
 *   AUTH credentials + body to cleartext; the client fails closed
 *   (`starttls-unavailable`) instead of proceeding cleartext. `implicit` is TLS
 *   from byte zero and trivially satisfies the floor.
 * - `tls.minVersion: 'TLSv1.2'` — pin the floor (RFC 8996 deprecates TLS 1.0/1.1,
 *   RFC 9325 mandates 1.2+). The direct-MX pool already pins this; without it the
 *   relay path's floor was Node's env-fragile process default.
 * - the connect/greeting timeout is bounded so an unreachable relay fails in a
 *   pre-wire phase (retryable) rather than tripping the ambiguous outer timeout.
 */
export function buildRelayClientConfig(input: RelayClientInput): RelayClientConfig {
	return {
		connect: {
			host: input.host,
			port: input.port,
			ehloName: input.ehloName,
			tlsMode: input.secure ? 'implicit' : 'starttls',
			// Fail closed if the STARTTLS relay omits the upgrade — credentials + body
			// must never reach a cleartext channel.
			requireTls: !input.secure,
			tls: { minVersion: 'TLSv1.2' as const },
			// Fail a merely-unreachable relay fast and retryably (see the constant).
			timeouts: {
				connect: SMTP_CONNECTION_TIMEOUT_MS,
				greeting: SMTP_CONNECTION_TIMEOUT_MS,
			},
		},
		auth: {
			credentials: { username: input.user, password: input.pass },
		},
	};
}

/**
 * Resolve (once) the relay client config from the instance-level env.
 * `SMTP_RELAY_SECURE=true` opens an implicit-TLS connection (typically 465);
 * unset/false connects cleartext and upgrades via STARTTLS (587). Auth
 * credentials are required — this deployment authenticates to the relay.
 */
function getClientConfig(): RelayClientConfig {
	if (cachedConfig) return cachedConfig;
	const host = getRequired('SMTP_RELAY_HOST');
	const portRaw = getOptional('SMTP_RELAY_PORT');
	const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_SMTP_PORT;
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(`Invalid SMTP_RELAY_PORT: ${portRaw}`);
	}
	const secure = getBoolean('SMTP_RELAY_SECURE');
	cachedConfig = buildRelayClientConfig({
		host,
		port,
		secure,
		user: getRequired('SMTP_RELAY_USERNAME'),
		pass: getRequired('SMTP_RELAY_PASSWORD'),
		ehloName: getOptional('EHLO_HOSTNAME') ?? os.hostname(),
	});
	return cachedConfig;
}

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

export const smtpSendProvider: SendProviderModule<'smtp'> = {
	kind: 'smtp',
	retryDelays: RETRY_DELAYS_MS,

	async sendEmail(params: EmailSendParams, _extras?: SmtpExtras): Promise<EmailSendAttempt> {
		let config: RelayClientConfig;
		try {
			config = getClientConfig();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
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
			return {
				success: false,
				errorMessage,
				errorCode: categorizeSmtpError(errorMessage),
			};
		}

		const sendAbort = new AbortController();
		try {
			await withTimeout(
				sendMessage({
					connect: config.connect,
					auth: config.auth,
					signal: sendAbort.signal,
					envelope: {
						from: composed.envelope.from,
						to: composed.envelope.to,
						data: composed.raw,
					},
				}),
				SMTP_SEND_TIMEOUT_MS,
				SMTP_SEND_TIMEOUT_MESSAGE
			);

			return { success: true, id: composed.messageId };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			// A structured SmtpError carries the protocol phase + reply code — the
			// only inputs the retry-vs-terminal decision is allowed to read.
			if (isSmtpError(error)) {
				return {
					success: false,
					errorMessage,
					errorCode: classifySmtpError({
						phase: error.phase,
						replyCode: error.replyCode,
						message: errorMessage,
						clientRefusal: error.clientRefusal,
					}),
				};
			}

			// Anything else escaping the send — the outer `withTimeout` sentinel, or
			// an unexpected throw — happened somewhere in the send with no structured
			// phase to prove it was pre-acceptance. The message MAY have been
			// delivered, so treat it as ambiguous and TERMINAL (never auto-retry).
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			};
		} finally {
			// Promise.race cannot cancel its losing branch. Close any live SMTP
			// socket when the outer deadline wins so the send does not continue in
			// the background and later deliver after we reported a timeout.
			sendAbort.abort();
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
