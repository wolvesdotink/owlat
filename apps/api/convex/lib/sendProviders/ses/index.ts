/**
 * SES Send provider adapter (module).
 *
 * Per ADR-0020. Single-attempt `sendEmail` via the AWS SDK; failures are
 * classified by the SDK error's `name` first, then fall back to substring
 * matching for cases where the SDK throws untyped errors.
 *
 * Attachment-bearing sends use `SendRawEmailCommand` with a manually-built
 * MIME body — preserved from the pre-deepening adapter (see
 * `lib/emailProviders/ses.ts:buildRawMimeMessage`). The MIME builder is
 * inlined here so this module is self-contained.
 */

import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { resolveSesClient } from '../../emailProviders/sesIdentity';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	type EmailAttachment,
	type EmailSendAttempt,
	type EmailSendParams,
	type SendProviderModule,
	type SesExtras,
} from '../types';
import { RETRY_DELAYS_MS } from '../../constants';

let cachedClient: SESClient | null = null;

function getSesClient(): SESClient {
	if (cachedClient) return cachedClient;
	// Shared client builder lives in sesIdentity.resolveSesClient; cache the
	// result here so the send hot path doesn't re-read env / rebuild per send.
	cachedClient = resolveSesClient();
	return cachedClient;
}

/**
 * Strip anything that could break out of a single header field-body when a
 * value is interpolated into the raw MIME header block (RFC 5322 §2.2: a
 * header is `field-name ":" field-body`, terminated by CRLF). CR/LF/NUL and
 * other control characters let an attacker-influenced value (From/To/Reply-To,
 * custom header keys+values, attachment filenames — all reachable by any
 * API-key holder, see `delivery/worker.ts`) smuggle extra header lines such as
 * `Bcc:`. We drop control chars (incl. CR/LF) rather than fold to a space so
 * the injected token can't survive as a runnable header line.
 */
export function escapeHeader(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, '');
}

/**
 * Produce a safe `filename="…"` parameter value for `Content-Type` /
 * `Content-Disposition` (RFC 2183). Strips control chars (so no CRLF
 * injection) and escapes the backslash and double-quote that would otherwise
 * escape or prematurely close the quoted-string. Kept to a simple ASCII
 * quoted-string; non-ASCII names degrade gracefully rather than risk a
 * malformed RFC 2231 parameter.
 */
export function safeAttachmentFilename(filename: string): string {
	return escapeHeader(filename)
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"');
}

/**
 * Build a raw MIME message for SES SendRawEmailCommand.
 *
 * Used whenever the plain `SendEmailCommand` cannot carry what we need:
 *   - attachments are present (SendEmailCommand has no attachment support), OR
 *   - custom headers are present (SendEmailCommand silently drops them, which
 *     would strip List-Unsubscribe / List-Unsubscribe-Post and break RFC 8058
 *     one-click unsubscribe on the no-attachment campaign path — see PR-17).
 *
 * When there are no attachments the message is emitted as a single
 * `text/html` part; otherwise it is wrapped in a `multipart/mixed` envelope.
 */
function buildRawMimeMessage(params: {
	from: string;
	to: string;
	subject: string;
	html: string;
	replyTo?: string;
	headers?: Record<string, string>;
	attachments: EmailAttachment[];
}): string {
	const lines: string[] = [];
	const hasAttachments = params.attachments.length > 0;
	const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	// Every interpolated field-body is attacker-influenced (any API-key holder
	// can supply From/To/Reply-To, custom headers and attachment filenames), so
	// strip CR/LF + control chars before they enter the raw header block — see
	// `escapeHeader`. The subject is base64 word-encoded, so it can't carry a
	// raw newline regardless.
	lines.push(`From: ${escapeHeader(params.from)}`);
	lines.push(`To: ${escapeHeader(params.to)}`);
	lines.push(`Subject: =?UTF-8?B?${Buffer.from(params.subject).toString('base64')}?=`);
	lines.push('MIME-Version: 1.0');
	if (params.replyTo) {
		lines.push(`Reply-To: ${escapeHeader(params.replyTo)}`);
	}
	if (params.headers) {
		for (const [key, value] of Object.entries(params.headers)) {
			lines.push(`${escapeHeader(key)}: ${escapeHeader(value)}`);
		}
	}

	const htmlBase64 = Buffer.from(params.html, 'utf-8').toString('base64');

	if (!hasAttachments) {
		// Single-part body: no envelope needed, the HTML part headers live in
		// the top-level header block. Custom headers above still apply.
		lines.push('Content-Type: text/html; charset=UTF-8');
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(htmlBase64);
		return lines.join('\r\n');
	}

	lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
	lines.push('');

	lines.push(`--${boundary}`);
	lines.push('Content-Type: text/html; charset=UTF-8');
	lines.push('Content-Transfer-Encoding: base64');
	lines.push('');
	lines.push(htmlBase64);
	lines.push('');

	for (const att of params.attachments) {
		const contentType = escapeHeader(att.contentType || 'application/octet-stream');
		const filename = safeAttachmentFilename(att.filename);
		lines.push(`--${boundary}`);
		lines.push(`Content-Type: ${contentType}; name="${filename}"`);
		lines.push('Content-Transfer-Encoding: base64');
		lines.push(`Content-Disposition: attachment; filename="${filename}"`);
		lines.push('');
		lines.push(att.content.toString('base64'));
		lines.push('');
	}

	lines.push(`--${boundary}--`);
	return lines.join('\r\n');
}

export const sesSendProvider: SendProviderModule<'ses'> = {
	kind: 'ses',
	retryDelays: RETRY_DELAYS_MS,

	async sendEmail(
		params: EmailSendParams,
		_extras?: SesExtras,
	): Promise<EmailSendAttempt> {
		let client: SESClient;
		try {
			client = getSesClient();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		try {
			let messageId: string | undefined;

			const hasAttachments = !!(params.attachments && params.attachments.length > 0);
			// `SendEmailCommand` silently drops custom headers, so any send that
			// carries headers (e.g. List-Unsubscribe / List-Unsubscribe-Post for
			// RFC 8058 one-click unsubscribe) MUST go through raw MIME even with
			// no attachments — otherwise the headers vanish on the campaign hot
			// path. See PR-17.
			const hasHeaders = !!(params.headers && Object.keys(params.headers).length > 0);

			if (hasAttachments || hasHeaders) {
				const rawMessage = buildRawMimeMessage({
					from: params.from,
					to: params.to,
					subject: params.subject,
					html: params.html,
					replyTo: params.replyTo,
					headers: params.headers,
					attachments: params.attachments ?? [],
				});

				const command = new SendRawEmailCommand({
					RawMessage: { Data: new TextEncoder().encode(rawMessage) },
				});
				const response = await client.send(command);
				messageId = response.MessageId;
			} else {
				const command = new SendEmailCommand({
					Source: params.from,
					Destination: { ToAddresses: [params.to] },
					Message: {
						Subject: { Data: params.subject, Charset: 'UTF-8' },
						Body: {
							Html: { Data: params.html, Charset: 'UTF-8' },
						},
					},
					ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
				});
				const response = await client.send(command);
				messageId = response.MessageId;
			}

			if (!messageId) {
				return {
					success: false,
					errorMessage: 'No message ID returned from SES',
					errorCode: EmailErrorCode.SERVER_ERROR,
				};
			}

			return { success: true, id: messageId };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			const errorName = error instanceof Error ? error.name : undefined;
			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(`${errorName ?? ''}: ${errorMessage}`),
			};
		}
	},

	/**
	 * Classify an SES error. The AWS SDK throws typed errors whose `name`
	 * carries the SES error code (e.g. `Throttling`, `MessageRejected`,
	 * `MailFromDomainNotVerified`). The dispatch helper passes
	 * `${error.name}: ${error.message}` so this method matches on either.
	 */
	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		if (httpStatus !== undefined) {
			const byStatus = httpStatusToErrorCode(httpStatus);
			if (byStatus !== undefined) return byStatus;
		}

		const lower = message.toLowerCase();

		if (
			lower.includes('throttling') ||
			lower.includes('throttl') ||
			lower.includes('toomanyrequests') ||
			lower.includes('too many requests') ||
			lower.includes('rate exceeded') ||
			lower.includes('sendingpausedexception')
		) {
			return EmailErrorCode.RATE_LIMIT;
		}
		if (
			lower.includes('serviceunavailable') ||
			lower.includes('internalfailure') ||
			lower.includes('internal error') ||
			lower.includes('timeout')
		) {
			return EmailErrorCode.SERVER_ERROR;
		}
		if (
			lower.includes('mailfromdomainnotverified') ||
			lower.includes('verificationmissing') ||
			lower.includes('configurationdoesnotexist') ||
			lower.includes('not verified')
		) {
			return EmailErrorCode.INVALID_SENDER;
		}
		if (
			lower.includes('accountsuspended') ||
			lower.includes('signaturedoesnotmatch') ||
			lower.includes('invalidclienttokenid') ||
			lower.includes('unrecognizedclient')
		) {
			return EmailErrorCode.AUTH_FAILED;
		}
		if (lower.includes('messagerejected') || lower.includes('content rejected') || lower.includes('spam')) {
			return EmailErrorCode.CONTENT_REJECTED;
		}
		if (lower.includes('invalidparameter') && (lower.includes('destination') || lower.includes('recipient'))) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}

		return EmailErrorCode.UNKNOWN;
	},
};

// Exported for tests that need to bypass the lazy-init cache between cases.
export function _resetSesClientCacheForTests(): void {
	cachedClient = null;
}
