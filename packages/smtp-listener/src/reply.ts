/**
 * SMTP reply serialization (RFC 5321 §4.2, RFC 3463 / RFC 2034 enhanced codes).
 *
 * A reply is `{ code, enhanced?, text }`. Serialization is byte-exact and the
 * ONLY place reply bytes are produced, so the wire format is auditable in one
 * spot. Multiline replies (an array `text`) use the `code-` continuation form
 * on every line but the last, which uses `code ` (a single space) — this is the
 * grammar EHLO capability lists require.
 *
 * Enhanced status codes, when present, are emitted immediately after the reply
 * code on EVERY line (RFC 2034 §4). Example: `{ code: 552, enhanced: '5.2.2',
 * text: 'mailbox full' }` serializes to exactly `552 5.2.2 mailbox full\r\n`.
 */

import type { SmtpReply } from './types.js';

const CRLF = '\r\n';

/**
 * Thrown by a handler to reject the current command with a specific reply. The
 * command loop catches it, serializes {@link reply}, and does NOT advance the
 * transaction state. Any other thrown error becomes a generic `451 4.3.0` so an
 * internal fault never leaks and never forges an accept.
 */
export class SmtpReplyError extends Error {
	readonly reply: SmtpReply;
	constructor(reply: SmtpReply) {
		super(typeof reply.text === 'string' ? reply.text : reply.text.join(' '));
		this.name = 'SmtpReplyError';
		this.reply = reply;
	}
}

/** Serialize a structured reply to its exact wire bytes (including trailing CRLF). */
export function serializeReply(reply: SmtpReply): string {
	const lines = Array.isArray(reply.text) ? reply.text : [reply.text];
	const code = String(reply.code);
	const enhanced = reply.enhanced;
	// A reply must have at least one line; treat an empty array as a single
	// empty-text line so the code is still emitted.
	const effective = lines.length > 0 ? lines : [''];
	const last = effective.length - 1;
	const out: string[] = [];
	for (let i = 0; i < effective.length; i++) {
		const sep = i === last ? ' ' : '-';
		const text = effective[i] ?? '';
		const parts: string[] = [];
		if (enhanced) parts.push(enhanced);
		if (text.length > 0) parts.push(text);
		const rest = parts.join(' ');
		out.push(rest.length > 0 ? `${code}${sep}${rest}` : code);
	}
	return out.join(CRLF) + CRLF;
}

/** Convenience: serialize directly to a UTF-8 Buffer for socket writes. */
export function replyBytes(reply: SmtpReply): Buffer {
	return Buffer.from(serializeReply(reply), 'utf8');
}

/**
 * Canonical reply table. These are the codes L1 emits from the command loop.
 * The enhanced codes follow RFC 3463 (D2 sanctioned "real enhanced codes"
 * improvement over ad-hoc library defaults); L3 pins any parity divergence
 * against `smtp-server` in a fixture.
 */
export const Reply = {
	greeting: (banner: string): SmtpReply => ({ code: 220, text: banner }),
	helloOk: (lines: string[]): SmtpReply => ({ code: 250, text: lines }),
	ok: (text = 'OK'): SmtpReply => ({ code: 250, enhanced: '2.0.0', text }),
	senderOk: (): SmtpReply => ({ code: 250, enhanced: '2.1.0', text: 'OK' }),
	recipientOk: (): SmtpReply => ({ code: 250, enhanced: '2.1.5', text: 'OK' }),
	dataAccepted: (text = 'OK: message accepted'): SmtpReply => ({
		code: 250,
		enhanced: '2.0.0',
		text,
	}),
	startMailInput: (): SmtpReply => ({
		code: 354,
		text: 'Start mail input; end with <CRLF>.<CRLF>',
	}),
	/** 220 acknowledging STARTTLS; the TLS handshake follows on this socket. */
	tlsReady: (): SmtpReply => ({ code: 220, text: 'Ready to start TLS' }),
	/** 334 SASL continuation. `challenge` is the (already base64) prompt, or ''. */
	authContinue: (challenge: string): SmtpReply => ({ code: 334, text: challenge }),
	/** 235 AUTH success. */
	authOk: (): SmtpReply => ({ code: 235, enhanced: '2.7.0', text: 'Authentication successful' }),
	/**
	 * 535 AUTH failure. The SINGLE reply emitted for every failed AUTH regardless
	 * of stage or cause — the no-auth-oracle invariant (D6).
	 */
	authFailed: (): SmtpReply => ({
		code: 535,
		enhanced: '5.7.8',
		text: 'Authentication credentials invalid',
	}),
	/** 530 AUTH refused because the channel is not yet encrypted (RFC 4954 §4). */
	encryptionRequired: (): SmtpReply => ({
		code: 530,
		enhanced: '5.7.0',
		text: 'Must issue a STARTTLS command first',
	}),
	bye: (hostname: string): SmtpReply => ({
		code: 221,
		enhanced: '2.0.0',
		text: `${hostname} closing connection`,
	}),
	syntaxError: (text = 'Syntax error, command unrecognized'): SmtpReply => ({
		code: 500,
		enhanced: '5.5.2',
		text,
	}),
	paramError: (text = 'Syntax error in parameters or arguments'): SmtpReply => ({
		code: 501,
		enhanced: '5.5.4',
		text,
	}),
	notImplemented: (text = 'Command not implemented'): SmtpReply => ({
		code: 502,
		enhanced: '5.5.1',
		text,
	}),
	badSequence: (text = 'Bad sequence of commands'): SmtpReply => ({
		code: 503,
		enhanced: '5.5.1',
		text,
	}),
	messageTooLarge: (maxBytes: number): SmtpReply => ({
		code: 552,
		enhanced: '5.3.4',
		text: `Message exceeds maximum size of ${Math.floor(maxBytes / (1024 * 1024))}MB`,
	}),
	localError: (text = 'Local error in processing'): SmtpReply => ({
		code: 451,
		enhanced: '4.3.0',
		text,
	}),
	tooManyErrors: (): SmtpReply => ({
		code: 421,
		enhanced: '4.7.0',
		text: 'Too many errors, closing connection',
	}),
	shuttingDown: (hostname: string): SmtpReply => ({
		code: 421,
		enhanced: '4.4.2',
		text: `${hostname} timeout, closing connection`,
	}),
} as const;
