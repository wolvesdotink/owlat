/**
 * RFC 8098 message disposition notification (a read receipt) for a message
 * that asked for one with `Disposition-Notification-To`.
 *
 * The receipt is a `multipart/report; report-type=disposition-notification`
 * with two parts: a short human-readable note, and the machine-readable
 * `message/disposition-notification` block that `../parse/mdn.ts` reads back.
 * Only the `displayed` disposition is built: that is the one a reader sends,
 * and the other types say nothing about reading.
 */

import { encodeAddressHeader, encodeHeaderValue, escapeHeader } from './headers';
import { encodeTextBody, randomBoundary } from './encoding';

export interface DispositionNotificationInput {
	/** The address the original was delivered to, which sends the receipt. */
	from: string;
	/** The original's `Disposition-Notification-To` address. */
	to: string;
	/** The original's Subject, as decoded text. */
	originalSubject: string;
	/** The original's Message-ID, with or without angle brackets. */
	originalMessageId: string;
	/** This receipt's own Message-ID, angle brackets included. */
	messageId: string;
	/**
	 * `manual`: the recipient chose to send it. `automatic`: a standing setting
	 * sent it without asking (RFC 8098 §3.2.6.1 action and sending modes).
	 */
	mode: 'manual' | 'automatic';
	/** Product token for `Reporting-UA`, e.g. `Owlat`. */
	reportingUa: string;
	date?: Date;
	boundary?: string;
}

/** `<id>` for an id given with or without its angle brackets. */
function bracketed(messageId: string): string {
	const bare = messageId.trim().replace(/^<|>$/g, '');
	return `<${bare}>`;
}

/** The addr-spec of `Name <addr>` or a bare `addr`. */
function addrSpec(address: string): string {
	const match = /<([^>]*)>\s*$/.exec(address);
	return (match ? match[1]! : address).trim();
}

/** `Disposition:` value for the mode (RFC 8098 §3.2.6). */
function dispositionValue(mode: DispositionNotificationInput['mode']): string {
	return mode === 'automatic'
		? 'automatic-action/MDN-sent-automatically; displayed'
		: 'manual-action/MDN-sent-manually; displayed';
}

/**
 * Build the receipt's wire bytes. Deterministic for a given `date` and
 * `boundary`; without them the current time and a random boundary are used.
 */
export function buildDispositionNotification(input: DispositionNotificationInput): {
	raw: Buffer;
	size: number;
} {
	const boundary = input.boundary ?? randomBoundary();
	const date = (input.date ?? new Date()).toUTCString().replace(/GMT$/, '+0000');
	const originalId = bracketed(input.originalMessageId);
	const recipient = escapeHeader(addrSpec(input.from));
	const reportingHost = recipient.split('@')[1] || 'localhost';

	const headers = [
		`Message-ID: ${input.messageId}`,
		`Date: ${date}`,
		`From: ${encodeAddressHeader([input.from])}`,
		`To: ${encodeAddressHeader([input.to])}`,
		`Subject: ${encodeHeaderValue(`Read: ${input.originalSubject || '(no subject)'}`)}`,
		`In-Reply-To: ${originalId}`,
		`References: ${originalId}`,
		// RFC 3834 §5: a receipt nobody chose to send is an automatic response, so
		// responders and receipt generators leave it alone.
		...(input.mode === 'automatic' ? ['Auto-Submitted: auto-replied'] : []),
		'MIME-Version: 1.0',
		`Content-Type: multipart/report; report-type=disposition-notification;\r\n boundary="${boundary}"`,
	];

	// The note does not claim the message was read or understood (RFC 8098 §1):
	// only that it was shown.
	const note = encodeTextBody(
		`This is a read receipt for the message you sent to ${recipient}.\r\n\r\n` +
			'It means the message was displayed. It does not guarantee that it was read or understood.\r\n'
	);

	const fields = [
		`Reporting-UA: ${reportingHost}; ${escapeHeader(input.reportingUa)}`,
		`Final-Recipient: rfc822; ${recipient}`,
		`Original-Message-ID: ${originalId}`,
		`Disposition: ${dispositionValue(input.mode)}`,
	];

	const body = [
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		`Content-Transfer-Encoding: ${note.cte}`,
		'',
		note.encoded,
		`--${boundary}`,
		'Content-Type: message/disposition-notification',
		'Content-Transfer-Encoding: 7bit',
		'',
		...fields,
		'',
		`--${boundary}--`,
		'',
	];

	const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`, 'utf-8');
	return { raw, size: raw.length };
}
