/**
 * FETCH-internal formatters. Pure functions over the envelope row shape
 * returned by `mail/imap/fetch:fetchEnvelopes`. Co-located with the FETCH
 * module because the only consumer is FETCH (and UID FETCH via the
 * UID dispatcher).
 *
 * UTC is used everywhere: `INTERNALDATE` always emits `+0000`. The
 * pre-deepening handler did the same.
 */

import { encodeWords } from '@owlat/mail-message/compose/headers';
import { collapseControlChars } from '@owlat/mail-message/parse/headers';

export interface FetchEnvelope {
	readonly _id: string;
	readonly uid: number;
	readonly modseq: number;
	readonly rawSize: number;
	readonly rfc822MessageId: string;
	readonly inReplyTo?: string;
	readonly references?: string[];
	readonly fromAddress: string;
	readonly fromName?: string;
	readonly toAddresses: string[];
	readonly ccAddresses: string[];
	readonly bccAddresses: string[];
	readonly replyToAddress?: string;
	readonly subject: string;
	readonly internalDate: number;
	readonly flagSeen: boolean;
	readonly flagFlagged: boolean;
	readonly flagAnswered: boolean;
	readonly flagDraft: boolean;
	readonly flagDeleted: boolean;
	readonly customFlags: string[];
}

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatFlags(m: FetchEnvelope): string {
	const flags: string[] = [];
	if (m.flagSeen) flags.push('\\Seen');
	if (m.flagFlagged) flags.push('\\Flagged');
	if (m.flagAnswered) flags.push('\\Answered');
	if (m.flagDraft) flags.push('\\Draft');
	if (m.flagDeleted) flags.push('\\Deleted');
	for (const f of m.customFlags) flags.push(f);
	return flags.join(' ');
}

export function formatInternalDate(ts: number): string {
	const d = new Date(ts);
	const day = pad(d.getUTCDate());
	const mon = MONTHS[d.getUTCMonth()];
	const year = d.getUTCFullYear();
	const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
	return `${day}-${mon}-${year} ${time} +0000`;
}

/**
 * An IMAP `string` (RFC 3501 §4.3) for an envelope field. Fields go through
 * {@link imapHeaderText} or {@link imapToken} first, so a literal here is the
 * fallback for what those leave, such as a non-ASCII address. A quoted string
 * holds only 7-bit chars other than CR and LF, so a value with CR, LF or any
 * non-ASCII char is sent as a literal, `{n}` CRLF then the n octets. The
 * response is written as UTF-8, so n is the value's UTF-8 length. NUL is
 * allowed in neither form and is dropped.
 */
export function imapString(s: string | undefined): string {
	if (s == null) return 'NIL';
	const value = s.replaceAll('\0', '');
	if (/[\r\n\u0080-\uffff]/.test(value)) {
		return `{${Buffer.byteLength(value, 'utf8')}}\r\n${value}`;
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * An RFC 2047 encoded word, matched as loosely as a decoder (ours,
 * `decodeEncodedWords`, or a client's) recognizes one.
 */
const ENCODED_WORD = /=\?[^?]+\?[bBqQ]\?[^?]*\?=/;

/**
 * An ENVELOPE text field: the subject or a display name. Clients rebuild
 * message headers from these, so control characters become a space; a stored
 * value may hold any. Non-ASCII text goes out as RFC 2047 encoded words, which
 * name their charset (a raw 8-bit string carries none, RFC 3501 §4.3.1), and
 * the ASCII result as a quoted string. ASCII text that itself reads as an
 * encoded word is encoded too, or a client would decode the stored, already
 * decoded text a second time. Address parts and message ids are not text and
 * go through {@link imapToken}.
 */
export function imapHeaderText(s: string | undefined): string {
	if (s == null) return 'NIL';
	const line = collapseControlChars(s);
	const encode = /[\u0080-\uffff]/.test(line) || ENCODED_WORD.test(line);
	return imapString(encode ? encodeWords(line).join(' ') : line);
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/g;

/**
 * An ENVELOPE field that is not text: the date, an address's mailbox or host,
 * a message id. None of them can hold a control character, and a client
 * copies them into the headers it rebuilds, so any control character (TAB
 * included) is dropped. They are never RFC 2047 encoded; a non-ASCII address
 * part still falls back to a literal in {@link imapString}.
 */
export function imapToken(s: string | undefined): string {
	return s == null ? 'NIL' : imapString(s.replace(CONTROL_CHAR, ''));
}

export function imapAddrList(addrs: ReadonlyArray<{ name?: string; address: string }>): string {
	if (addrs.length === 0) return 'NIL';
	const parts = addrs.map((a) => {
		const [user, host] = a.address.split('@');
		return `(${imapHeaderText(a.name)} NIL ${imapToken(user ?? a.address)} ${imapToken(host ?? '')})`;
	});
	return `(${parts.join(' ')})`;
}

export function formatEnvelope(m: FetchEnvelope): string {
	const date = new Date(m.internalDate).toUTCString();
	const subject = imapHeaderText(m.subject);
	const from = imapAddrList([{ name: m.fromName, address: m.fromAddress }]);
	const sender = from;
	const replyTo = m.replyToAddress ? imapAddrList([{ address: m.replyToAddress }]) : from;
	const to = imapAddrList(m.toAddresses.map((a) => ({ address: a })));
	const cc = imapAddrList(m.ccAddresses.map((a) => ({ address: a })));
	const bcc = imapAddrList(m.bccAddresses.map((a) => ({ address: a })));
	const inReplyTo = m.inReplyTo ? imapToken(`<${m.inReplyTo}>`) : 'NIL';
	const messageId = imapToken(`<${m.rfc822MessageId}>`);
	return `(${imapToken(date)} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReplyTo} ${messageId})`;
}
