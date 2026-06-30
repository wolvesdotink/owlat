/**
 * FETCH-internal formatters. Pure functions over the envelope row shape
 * returned by `mailImap:fetchEnvelopes`. Co-located with the FETCH
 * module because the only consumer is FETCH (and UID FETCH via the
 * UID dispatcher).
 *
 * UTC is used everywhere: `INTERNALDATE` always emits `+0000`. The
 * pre-deepening handler did the same.
 */

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
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
	'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
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

export function imapString(s: string | undefined): string {
	if (s == null) return 'NIL';
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function imapAddrList(
	addrs: ReadonlyArray<{ name?: string; address: string }>,
): string {
	if (addrs.length === 0) return 'NIL';
	const parts = addrs.map((a) => {
		const [user, host] = a.address.split('@');
		return `(${imapString(a.name)} NIL ${imapString(user ?? a.address)} ${imapString(host ?? '')})`;
	});
	return `(${parts.join(' ')})`;
}

export function formatEnvelope(m: FetchEnvelope): string {
	const date = new Date(m.internalDate).toUTCString();
	const subject = imapString(m.subject);
	const from = imapAddrList([{ name: m.fromName, address: m.fromAddress }]);
	const sender = from;
	const replyTo = m.replyToAddress
		? imapAddrList([{ address: m.replyToAddress }])
		: from;
	const to = imapAddrList(m.toAddresses.map((a) => ({ address: a })));
	const cc = imapAddrList(m.ccAddresses.map((a) => ({ address: a })));
	const bcc = imapAddrList(m.bccAddresses.map((a) => ({ address: a })));
	const inReplyTo = m.inReplyTo ? imapString(`<${m.inReplyTo}>`) : 'NIL';
	const messageId = imapString(`<${m.rfc822MessageId}>`);
	return `(${imapString(date)} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReplyTo} ${messageId})`;
}
