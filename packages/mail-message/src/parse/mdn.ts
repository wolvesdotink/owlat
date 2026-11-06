/**
 * RFC 8098 message disposition notifications (read receipts): recognise one and
 * read the three fields a sender needs from it.
 *
 * A receipt is a `multipart/report; report-type=disposition-notification`
 * whose machine-readable part is `message/disposition-notification`. That part
 * is a block of header-shaped fields; the ones read here are
 * `Original-Message-ID` (which sent message it answers), `Final-Recipient`
 * (whose mailbox displayed it) and `Disposition` (what happened to it).
 *
 * Anything that is not that exact shape answers `null`, so the caller treats the
 * message as ordinary mail. The human-readable first part is never read: it is
 * free text in the recipient's language.
 */

import { parseContentType, parseHeaders, type MessageHeaders } from './headers';
import { parseMimeTree, transferDecode, walkLeaves } from './body';
import { parseAddressList } from './address';

/**
 * The disposition types RFC 8098 §3.2.6.2 defines. `dispatched` and
 * `processed` were removed from the RFC but are still sent by old clients.
 */
export type DispositionType = 'displayed' | 'deleted' | 'dispatched' | 'processed';

const DISPOSITION_TYPES: ReadonlySet<string> = new Set<DispositionType>([
	'displayed',
	'deleted',
	'dispatched',
	'processed',
]);

export interface DispositionNotification {
	/** `Original-Message-ID` without angle brackets. */
	originalMessageId: string;
	/** Address from `Final-Recipient` (`rfc822; ben@example.com`), lowercased. */
	finalRecipient?: string;
	disposition: DispositionType;
	/** The receipt was sent without the recipient choosing to (`automatic-action`). */
	isAutomatic: boolean;
}

/**
 * Cheap pre-check on the top-level `Content-Type` header value: only a
 * disposition-notification report is worth walking the MIME tree for.
 */
export function isDispositionNotificationReport(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const parsed = parseContentType(contentType);
	return (
		parsed.value === 'multipart/report' &&
		(parsed.params['report-type'] ?? '').toLowerCase() === 'disposition-notification'
	);
}

/** The address of an `address-type; address` field, lowercased. */
function typedAddress(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const semi = raw.indexOf(';');
	const address = (semi < 0 ? raw : raw.slice(semi + 1)).trim().replace(/^<|>$/g, '');
	return address.includes('@') ? address.toLowerCase() : undefined;
}

/**
 * `Disposition: action-mode/sending-mode; type/modifier` → its type and whether
 * the action mode was automatic. Unknown or missing types answer `null`.
 */
function readDisposition(
	raw: string | undefined
): { type: DispositionType; isAutomatic: boolean } | null {
	if (!raw) return null;
	const semi = raw.indexOf(';');
	if (semi < 0) return null;
	const mode = raw.slice(0, semi).trim().toLowerCase();
	const type = raw
		.slice(semi + 1)
		.split('/')[0]!
		.trim()
		.toLowerCase();
	if (!DISPOSITION_TYPES.has(type)) return null;
	return { type: type as DispositionType, isAutomatic: mode.startsWith('automatic-action') };
}

function readFields(fields: MessageHeaders): DispositionNotification | null {
	const originalMessageId = fields.get('original-message-id')?.replace(/[<>]/g, '').trim();
	if (!originalMessageId) return null;
	const disposition = readDisposition(fields.get('disposition'));
	if (!disposition) return null;
	const finalRecipient = typedAddress(fields.get('final-recipient'));
	return {
		originalMessageId,
		...(finalRecipient ? { finalRecipient } : {}),
		disposition: disposition.type,
		isAutomatic: disposition.isAutomatic,
	};
}

/**
 * Parse a raw message (as a binary string) as a read receipt. `null` when it is
 * not a disposition-notification report or its notification part lacks an
 * original message id or a known disposition.
 */
export function parseDispositionNotification(raw: string): DispositionNotification | null {
	const root = parseMimeTree(raw);
	if (!isDispositionNotificationReport(root.headers.last('content-type'))) return null;
	let notification: DispositionNotification | null = null;
	walkLeaves(root, (leaf) => {
		if (notification || leaf.contentType.value !== 'message/disposition-notification') return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		notification = readFields(parseHeaders(new TextDecoder().decode(bytes)));
	});
	return notification;
}

/**
 * The address a `Disposition-Notification-To` header value asks the receipt to
 * be sent to, lowercased. `undefined` unless the value names exactly one
 * mailbox: RFC 8098 §2.1 lets a request name several, and a receipt for more
 * than one address is never sent without asking, so it is not kept at all.
 */
export function readDispositionNotificationTo(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const mailboxes = parseAddressList(value);
	const only = mailboxes.length === 1 ? mailboxes[0] : undefined;
	if (!only || only.group || !only.address.includes('@')) return undefined;
	return only.address;
}
