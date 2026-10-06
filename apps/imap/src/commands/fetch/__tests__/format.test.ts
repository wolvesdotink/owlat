import { describe, it, expect } from 'vitest';
import {
	formatFlags,
	formatInternalDate,
	imapString,
	imapAddrList,
	formatEnvelope,
	type FetchEnvelope,
} from '../format.js';

function envelope(overrides: Partial<FetchEnvelope> = {}): FetchEnvelope {
	return {
		_id: 'm1',
		uid: 7,
		modseq: 1,
		rawSize: 1234,
		rfc822MessageId: 'mid-1@example.com',
		fromAddress: 'jane@example.com',
		fromName: 'Jane Doe',
		toAddresses: ['bob@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hello',
		internalDate: Date.UTC(2026, 5, 9, 10, 30, 5),
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		...overrides,
	};
}

describe('formatFlags', () => {
	it('emits the system flags that are set, in IMAP form', () => {
		expect(formatFlags(envelope({ flagSeen: true, flagAnswered: true }))).toBe('\\Seen \\Answered');
	});

	it('appends custom flags after system flags', () => {
		expect(formatFlags(envelope({ flagFlagged: true, customFlags: ['$Forwarded'] }))).toBe(
			'\\Flagged $Forwarded'
		);
	});

	it('emits an empty string when nothing is set', () => {
		expect(formatFlags(envelope())).toBe('');
	});

	// PR-62 regression-lock (5): the canonical system-flag ORDER is fixed.
	// Clients diff the FLAGS list; a reordering churns no-op updates and trips
	// brittle parsers. Order is always Seen, Flagged, Answered, Draft, Deleted,
	// then custom keywords.
	it('emits all system flags in the canonical order, custom flags last', () => {
		expect(
			formatFlags(
				envelope({
					flagDeleted: true,
					flagDraft: true,
					flagAnswered: true,
					flagFlagged: true,
					flagSeen: true,
					customFlags: ['$Forwarded', 'NonJunk'],
				})
			)
		).toBe('\\Seen \\Flagged \\Answered \\Draft \\Deleted $Forwarded NonJunk');
	});

	it('only ever emits the five backslash system flags (no $-keyword leakage into system slots)', () => {
		const out = formatFlags(envelope({ flagSeen: true, flagDeleted: true }));
		const systemFlags = out.split(' ').filter((f) => f.startsWith('\\'));
		expect(systemFlags).toEqual(['\\Seen', '\\Deleted']);
	});
});

describe('formatInternalDate', () => {
	it('formats as dd-Mon-yyyy hh:mm:ss +0000 in UTC', () => {
		expect(formatInternalDate(Date.UTC(2026, 5, 9, 10, 30, 5))).toBe('09-Jun-2026 10:30:05 +0000');
	});

	// PR-62 regression-lock (5): INTERNALDATE shape per RFC 3501 §9 date-time.
	it('zero-pads day, hours, minutes, seconds to a fixed-width field', () => {
		// 1 Jan 2026 03:04:09 UTC — every numeric component needs padding.
		expect(formatInternalDate(Date.UTC(2026, 0, 1, 3, 4, 9))).toBe('01-Jan-2026 03:04:09 +0000');
	});

	it('always renders the +0000 UTC zone (server stores/serves UTC)', () => {
		expect(formatInternalDate(Date.UTC(2026, 11, 31, 23, 59, 59))).toMatch(/ \+0000$/);
	});

	it('matches the strict dd-Mon-yyyy HH:MM:SS +0000 grammar', () => {
		expect(formatInternalDate(Date.UTC(2026, 5, 9, 10, 30, 5))).toMatch(
			/^\d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4} \d{2}:\d{2}:\d{2} \+0000$/
		);
	});
});

describe('imapString', () => {
	it('quotes and escapes backslashes and quotes', () => {
		expect(imapString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
	});

	it('emits NIL for null/undefined', () => {
		expect(imapString(undefined)).toBe('NIL');
	});

	it('sends a value with CR or LF as a literal', () => {
		expect(imapString('hello\r\n* BYE x')).toBe('{14}\r\nhello\r\n* BYE x');
		expect(imapString('a\nb')).toBe('{3}\r\na\nb');
	});

	it('sends a non-ASCII value as a literal counted in UTF-8 octets', () => {
		expect(imapString('Grüße 😠')).toBe('{12}\r\nGrüße 😠');
	});

	it('drops NUL, which neither form may carry', () => {
		expect(imapString('a\0b')).toBe('"ab"');
		expect(imapString('ä\0')).toBe('{2}\r\nä');
	});
});

describe('imapAddrList', () => {
	it('splits mailbox and host', () => {
		expect(imapAddrList([{ name: 'Jane', address: 'jane@example.com' }])).toBe(
			'(("Jane" NIL "jane" "example.com"))'
		);
	});

	it('emits NIL for an empty list', () => {
		expect(imapAddrList([])).toBe('NIL');
	});
});

describe('formatEnvelope', () => {
	it('produces the 10-field RFC 3501 envelope', () => {
		const out = formatEnvelope(
			envelope({ inReplyTo: 'parent@example.com', replyToAddress: 'reply@example.com' })
		);
		expect(out).toContain('"Hello"');
		expect(out).toContain('(("Jane Doe" NIL "jane" "example.com"))');
		expect(out).toContain('"<parent@example.com>"');
		expect(out).toContain('"<mid-1@example.com>"');
		// reply-to differs from from when replyToAddress is set
		expect(out).toContain('((NIL NIL "reply" "example.com"))');
	});

	it('falls back reply-to to from and NILs the rest', () => {
		const out = formatEnvelope(envelope({ ccAddresses: [], bccAddresses: [] }));
		expect(out).toContain('NIL NIL "<mid-1@example.com>"');
	});

	// PR-62 regression-lock (5): the envelope is a parenthesized list of
	// EXACTLY 10 top-level fields in RFC 3501 §7.4.2 order:
	//   date subject from sender reply-to to cc bcc in-reply-to message-id
	// A dropped/extra field shifts every subsequent field for the client.
	it('produces exactly 10 top-level envelope fields in RFC 3501 order', () => {
		const out = formatEnvelope(
			envelope({ inReplyTo: 'parent@example.com', replyToAddress: 'reply@example.com' })
		);
		expect(out.startsWith('(')).toBe(true);
		expect(out.endsWith(')')).toBe(true);

		// Split the top-level list while respecting nested parens + quoted strings.
		const fields = splitEnvelopeFields(out);
		expect(fields).toHaveLength(10);

		// Positional spot-checks: field 1 = date string, field 2 = subject,
		// field 9 = in-reply-to, field 10 = message-id.
		expect(fields[1]).toBe('"Hello"');
		expect(fields[8]).toBe('"<parent@example.com>"');
		expect(fields[9]).toBe('"<mid-1@example.com>"');
		// from (3), sender (4), reply-to (5), to (6) are address lists or NIL.
		expect(fields[2]).toBe('(("Jane Doe" NIL "jane" "example.com"))');
		expect(fields[4]).toBe('((NIL NIL "reply" "example.com"))');
	});

	it('keeps a FETCH response framed when a subject or name carries CR/LF', () => {
		const line = `* 1 FETCH (UID 7 ENVELOPE ${formatEnvelope(
			envelope({ subject: 'hello\r\n* BYE x\r\n', fromName: 'Jäne\nDoe' })
		)})`;
		const { text, literals } = readLiterals(Buffer.from(line, 'utf8'));
		// The subject, then the name in from, sender and reply-to (which fall back to from).
		expect(literals).toEqual(['hello\r\n* BYE x\r\n', ...Array(3).fill('Jäne\nDoe')]);
		// Outside the literals the response is one line of balanced parens.
		expect(text).not.toMatch(/[\r\n]/);
		expect(text.startsWith('* 1 FETCH (UID 7 ENVELOPE (')).toBe(true);
		expect(splitEnvelopeFields(text.slice('* 1 FETCH (UID 7 ENVELOPE '.length, -1))).toHaveLength(
			10
		);
	});

	it('keeps 10 fields even when every optional address slot is NIL', () => {
		const out = formatEnvelope(envelope({ toAddresses: [], ccAddresses: [], bccAddresses: [] }));
		const fields = splitEnvelopeFields(out);
		expect(fields).toHaveLength(10);
		// to / cc / bcc collapse to NIL but the field still occupies its slot.
		expect(fields[5]).toBe('NIL');
		expect(fields[6]).toBe('NIL');
		expect(fields[7]).toBe('NIL');
	});
});

/**
 * Split the top-level fields of a `(...)` IMAP envelope, honouring nested
 * parens and quoted strings (with backslash escapes) so a comma-free,
 * space-delimited list parses into its 10 components.
 */
function splitEnvelopeFields(envelopeStr: string): string[] {
	const inner = envelopeStr.slice(1, -1); // strip the outer parens
	const fields: string[] = [];
	let depth = 0;
	let inQuote = false;
	let cur = '';
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (inQuote) {
			cur += ch;
			if (ch === '\\') {
				cur += inner[++i] ?? '';
			} else if (ch === '"') {
				inQuote = false;
			}
			continue;
		}
		if (ch === '"') {
			inQuote = true;
			cur += ch;
		} else if (ch === '(') {
			depth++;
			cur += ch;
		} else if (ch === ')') {
			depth--;
			cur += ch;
		} else if (ch === ' ' && depth === 0) {
			if (cur.length > 0) fields.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	if (cur.length > 0) fields.push(cur);
	return fields;
}

/**
 * Read a response the way an IMAP client does: a `{n}` CRLF takes the next n
 * octets as a literal, whatever they hold. Returns the response with each
 * literal replaced by `L`, and the literals in order.
 */
function readLiterals(octets: Buffer): { text: string; literals: string[] } {
	const literals: string[] = [];
	let text = '';
	let i = 0;
	while (i < octets.length) {
		const rest = octets.subarray(i).toString('latin1');
		const open = /^\{(\d+)\}\r\n/.exec(rest);
		if (open) {
			const start = i + open[0].length;
			const end = start + Number(open[1]);
			literals.push(octets.subarray(start, end).toString('utf8'));
			text += 'L';
			i = end;
			continue;
		}
		text += String.fromCharCode(octets[i]!);
		i += 1;
	}
	return { text, literals };
}
