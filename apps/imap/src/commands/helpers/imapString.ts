/**
 * An IMAP `string` (RFC 3501 §4.3), the one place a response quotes a value.
 * FETCH sends envelope fields through it after `fetch/format.ts` has shaped
 * them, so a literal here is the fallback for what that leaves, such as a
 * non-ASCII address. Mailbox names arrive already modified UTF-7 encoded
 * (`mailboxName.ts`), which leaves only printable ASCII, so they are always
 * quoted. A quoted string holds only 7-bit chars other than CR and LF, so a
 * value with CR, LF or any non-ASCII char is sent as a literal, `{n}` CRLF
 * then the n octets. The response is written as UTF-8, so n is the value's
 * UTF-8 length. NUL is allowed in neither form, so a value holding one is
 * `NIL`; nothing is deleted from it.
 */
export function imapString(s: string | undefined): string {
	if (s == null || s.includes('\0')) return 'NIL';
	if (/[\r\n\u0080-￿]/.test(s)) {
		return `{${Buffer.byteLength(s, 'utf8')}}\r\n${s}`;
	}
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
