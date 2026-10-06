/**
 * Mailbox names on the wire. The server speaks IMAP4rev1 and advertises
 * neither UTF8=ACCEPT nor IMAP4rev2, so a mailbox name travels in modified
 * UTF-7 (RFC 3501 §5.1.3) both ways: responses encode the stored name, and a
 * name in a command is decoded before it is matched against the stored ones.
 *
 * Modified UTF-7: printable US-ASCII (0x20-0x7e) other than `&` stands for
 * itself, `&` is `&-`, and every other run of UTF-16 code units is base64
 * between `&` and `-`, with `,` in place of `/` and no `=` padding. The
 * hierarchy delimiter `/` is printable, so it always stands for itself and a
 * path keeps its levels. C0 controls and DEL are not printable either, so an
 * encoded name never holds CR, LF or NUL.
 */

import { imapString } from './imapString.js';

const AMPERSAND = 0x26;

const isPrintableAscii = (unit: number): boolean => unit >= 0x20 && unit <= 0x7e;

/** Modified base64 of UTF-16 code units: big-endian, `,` for `/`, unpadded. */
function encodeUnits(units: readonly number[]): string {
	const bytes = Buffer.alloc(units.length * 2);
	for (let i = 0; i < units.length; i++) bytes.writeUInt16BE(units[i]!, i * 2);
	return bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',');
}

/** Encode a stored mailbox name in modified UTF-7. */
export function encodeMailboxName(name: string): string {
	let out = '';
	let run: number[] = [];
	const flush = () => {
		if (run.length === 0) return;
		out += `&${encodeUnits(run)}-`;
		run = [];
	};
	for (let i = 0; i < name.length; i++) {
		const unit = name.charCodeAt(i);
		if (!isPrintableAscii(unit)) {
			run.push(unit);
			continue;
		}
		flush();
		out += unit === AMPERSAND ? '&-' : name[i];
	}
	flush();
	return out;
}

const MODIFIED_BASE64 = /^[A-Za-z0-9+,]+$/;

/**
 * The text a modified base64 run stands for, or null when the run is not
 * one an encoder writes: it must hold whole UTF-16 code units with zero
 * padding bits (re-encoding gives the same run back), and none of them may
 * be printable ASCII, which RFC 3501 §5.1.3 requires to stand for itself.
 */
function decodeUnits(run: string): string | null {
	if (!MODIFIED_BASE64.test(run)) return null;
	const bytes = Buffer.from(run.replace(/,/g, '/'), 'base64');
	if (bytes.length < 2 || bytes.length % 2 !== 0) return null;
	const units: number[] = [];
	let text = '';
	for (let i = 0; i < bytes.length; i += 2) {
		const unit = bytes.readUInt16BE(i);
		if (isPrintableAscii(unit)) return null;
		units.push(unit);
		text += String.fromCharCode(unit);
	}
	return encodeUnits(units) === run ? text : null;
}

/**
 * Decode a mailbox name from a client command, or null when it is not valid
 * modified UTF-7: a char outside printable ASCII, an `&` with no closing `-`,
 * or a base64 run {@link decodeUnits} refuses.
 */
export function decodeMailboxName(wire: string): string | null {
	let out = '';
	let i = 0;
	while (i < wire.length) {
		const unit = wire.charCodeAt(i);
		if (!isPrintableAscii(unit)) return null;
		if (unit !== AMPERSAND) {
			out += wire[i];
			i += 1;
			continue;
		}
		const end = wire.indexOf('-', i + 1);
		if (end === -1) return null;
		const run = wire.slice(i + 1, end);
		const text = run === '' ? '&' : decodeUnits(run);
		if (text === null) return null;
		out += text;
		i = end + 1;
	}
	return out;
}

/**
 * The stored name a client's mailbox argument refers to. A name that is not
 * valid modified UTF-7 is taken as sent, so a client that sends raw UTF-8, or
 * an unencoded `&` as in `AT&T`, still reaches the folder it named before
 * names were decoded.
 */
export function mailboxNameFromClient(wire: string): string {
	return decodeMailboxName(wire) ?? wire;
}

/**
 * A stored mailbox name as it goes into a response (LIST, LSUB, STATUS):
 * modified UTF-7, then an IMAP string. Encoding leaves only printable ASCII,
 * so this is always a quoted string with `"` and `\` escaped; the literal
 * {@link imapString} falls back to is never needed.
 */
export function imapMailboxName(name: string): string {
	return imapString(encodeMailboxName(name));
}
