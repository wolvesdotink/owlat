'use node';

/**
 * The one mapping from a Send's `EmailSendParams` to the `@owlat/mail-message`
 * composer input, shared by every adapter that sends its own MIME (SMTP relay,
 * Mandrill `send-raw`, SES `SendRawEmailCommand`).
 *
 * Keeping it in one place is what keeps those adapters in step: the
 * plain-text part (`text`, derived from the UNTRACKED html so it carries no
 * redirect links), the Reply-To, the custom headers (List-Unsubscribe,
 * Feedback-ID) and the attachments reach the wire the same way on each of
 * them. Header sanitising, the Message-ID and the Date belong to the composer.
 *
 * `'use node'` because `EmailAttachment.content` is runtime-neutral bytes and
 * the composer takes a Node `Buffer`; the conversion happens here, at the
 * boundary, and only Node adapters import this module.
 */

import type { ComposeMessageInput } from '@owlat/mail-message';
import type { EmailSendParams } from './types';

export function toComposeInput(params: EmailSendParams): ComposeMessageInput {
	return {
		from: params.from,
		to: [params.to],
		subject: params.subject,
		html: params.html,
		text: params.text,
		replyTo: params.replyTo,
		headers: params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined,
		attachments: params.attachments?.map((a) => ({
			filename: a.filename,
			contentType: a.contentType ?? 'application/octet-stream',
			isInline: false,
			data: Buffer.from(a.content),
		})),
	};
}
