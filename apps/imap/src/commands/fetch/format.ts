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
import { imapString } from '../helpers/imapString.js';

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
 * go through {@link imapAddrList} and {@link imapId}.
 */
export function imapHeaderText(s: string | undefined): string {
	if (s == null) return 'NIL';
	const line = collapseControlChars(s);
	const encode = /[\u0080-\uffff]/.test(line) || ENCODED_WORD.test(line);
	return imapString(encode ? encodeWords(line).join(' ') : line);
}

/**
 * A control character no message id or address may hold: C0 other than TAB,
 * and DEL. TAB and space are valid where the grammar allows them (a quoted
 * local part, RFC 5322 §3.2.4) and go out as they are.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVALID_IN_TOKEN = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * A Message-ID or In-Reply-To, or `NIL` when there is none or it holds a
 * character no message id can (see {@link INVALID_IN_TOKEN}). An invalid id
 * is never repaired: a changed id could match an unrelated message's, and a
 * client threads by it. Never RFC 2047 encoded.
 */
export function imapId(id: string | undefined): string {
	return id === undefined || INVALID_IN_TOKEN.test(id) ? 'NIL' : imapString(`<${id}>`);
}

/**
 * An ENVELOPE address list. An address whose mailbox or host holds a
 * character no address can (see {@link INVALID_IN_TOKEN}) is left out with
 * its display name, never repaired, so a client cannot reply to a different
 * address than the stored one; a list left empty is `NIL`. Mailbox and host
 * are never RFC 2047 encoded; a non-ASCII one goes out as a literal.
 */
export function imapAddrList(addrs: ReadonlyArray<{ name?: string; address: string }>): string {
	const parts = addrs
		.filter((a) => !INVALID_IN_TOKEN.test(a.address))
		.map((a) => {
			const { mailbox, host } = splitAddrSpec(a.address);
			return `(${imapHeaderText(a.name)} NIL ${imapString(mailbox)} ${imapString(host)})`;
		});
	return parts.length === 0 ? 'NIL' : `(${parts.join(' ')})`;
}

/**
 * An addr-spec split into mailbox and host at its separating `@`: the last
 * one outside a quoted local part (with its `\` escapes) and outside a `[...]`
 * domain literal, either of which may hold `@` (RFC 5322 §3.4.1). With no such
 * `@` the whole value is the mailbox and the host is empty.
 */
export function splitAddrSpec(address: string): { mailbox: string; host: string } {
	let at = -1;
	let quoted = false;
	let literal = false;
	for (let i = 0; i < address.length; i++) {
		const ch = address[i];
		if (quoted || literal) {
			if (ch === '\\') i += 1;
			else if (quoted && ch === '"') quoted = false;
			else if (literal && ch === ']') literal = false;
		} else if (ch === '"') quoted = true;
		else if (ch === '[') literal = true;
		else if (ch === '@') at = i;
	}
	return at === -1
		? { mailbox: address, host: '' }
		: { mailbox: address.slice(0, at), host: address.slice(at + 1) };
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
	const inReplyTo = imapId(m.inReplyTo || undefined);
	const messageId = imapId(m.rfc822MessageId);
	return `(${imapString(date)} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReplyTo} ${messageId})`;
}
