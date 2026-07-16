import { describe, expect, it } from 'vitest';
import { DotStuffEncoder, dotStuffMessage } from '../src/dotStuff';

/**
 * Independent REFERENCE decoder. Written from scratch (not reusing encoder
 * internals) so an encoder bug cannot be masked by a mirrored decoder bug. It
 * inverts the on-the-wire form back to the canonical wire body.
 */
function referenceUnstuff(encoded: Buffer): Buffer {
	const text = encoded.toString('latin1');
	// The payload always ends with the terminator line `.\r\n`.
	expect(text.endsWith('.\r\n')).toBe(true);
	const bodyWire = text.slice(0, -'.\r\n'.length);
	if (bodyWire === '') {
		return Buffer.alloc(0);
	}
	// The wire body always ends on a CRLF boundary before the terminator.
	expect(bodyWire.endsWith('\r\n')).toBe(true);
	const lines = bodyWire.slice(0, -'\r\n'.length).split('\r\n');
	const unstuffed = lines.map((line) => (line.startsWith('.') ? line.slice(1) : line));
	return Buffer.from(unstuffed.join('\r\n') + '\r\n', 'latin1');
}

/**
 * The canonical target of the round trip: normalise CR / LF / CRLF to CRLF and
 * guarantee a trailing CRLF for a non-empty body (the terminator forces a final
 * line boundary on the wire).
 */
function toWireBody(input: Buffer): Buffer {
	const normalised = input.toString('latin1').replace(/\r\n|\r|\n/g, '\r\n');
	if (normalised === '') {
		return Buffer.alloc(0);
	}
	const withTrailer = normalised.endsWith('\r\n') ? normalised : normalised + '\r\n';
	return Buffer.from(withTrailer, 'latin1');
}

/** Feed a body to the encoder split at every `chunkSize` offset. */
function encodeChunked(input: Buffer, chunkSize: number): Buffer {
	const encoder = new DotStuffEncoder();
	const parts: Buffer[] = [];
	for (let i = 0; i < input.length; i += chunkSize) {
		parts.push(encoder.transform(input.subarray(i, i + chunkSize)));
	}
	parts.push(encoder.final());
	return Buffer.concat(parts);
}

const ADVERSARIAL: Array<[string, Buffer]> = [
	['empty', Buffer.from('')],
	['single dot line', Buffer.from('.\r\n')],
	['lone dot no newline', Buffer.from('.')],
	['double dot line', Buffer.from('..\r\n')],
	['leading dot with text', Buffer.from('.hidden command\r\n')],
	['dot mid-line stays', Buffer.from('a.b.c\r\n')],
	['CR only line endings', Buffer.from('line1\rline2\rline3')],
	['LF only line endings', Buffer.from('line1\nline2\nline3')],
	['mixed CR LF CRLF', Buffer.from('a\r\nb\rc\nd')],
	['CRLF then dot', Buffer.from('header\r\n.body\r\n')],
	['bare CR before dot', Buffer.from('x\r.y')],
	['trailing CR', Buffer.from('trailing\r')],
	['consecutive newlines', Buffer.from('a\r\n\r\n\r\n.b')],
	['no trailing newline', Buffer.from('no newline at end')],
	['dot only body', Buffer.from('...')],
];

describe('dot-stuffing round trip', () => {
	for (const [name, body] of ADVERSARIAL) {
		it(`round-trips: ${name}`, () => {
			const encoded = dotStuffMessage(body);
			expect(referenceUnstuff(encoded)).toEqual(toWireBody(body));
		});
	}

	it('produces byte-identical output regardless of chunk boundaries', () => {
		for (const [, body] of ADVERSARIAL) {
			const whole = dotStuffMessage(body);
			for (const chunkSize of [1, 2, 3, 7]) {
				expect(encodeChunked(body, chunkSize)).toEqual(whole);
			}
		}
	});

	it('handles a 5MB body (chunked, boundary-safe, still round-trips)', () => {
		const unit = Buffer.from('.leading dot line that must be stuffed\r\n');
		const repeats = Math.ceil((5 * 1024 * 1024) / unit.length);
		const big = Buffer.concat(Array.from({ length: repeats }, () => unit));
		expect(big.length).toBeGreaterThan(5 * 1024 * 1024);

		const whole = dotStuffMessage(big);
		expect(referenceUnstuff(whole)).toEqual(toWireBody(big));
		// A large odd chunk size to exercise cross-chunk CR/dot state.
		expect(encodeChunked(big, 4093)).toEqual(whole);
	});

	it('always terminates with <CRLF>.<CRLF> and never bare-terminates', () => {
		const encoded = dotStuffMessage('body\r\n');
		expect(encoded.toString('latin1').endsWith('\r\n.\r\n')).toBe(true);
	});

	it('stuffs an extra dot on every line that begins with a dot', () => {
		const encoded = dotStuffMessage('.a\r\n.b\r\nc\r\n.d\r\n').toString('latin1');
		expect(encoded).toBe('..a\r\n..b\r\nc\r\n..d\r\n.\r\n');
	});
});

describe('DotStuffEncoder guards', () => {
	it('throws if transform is called after final', () => {
		const encoder = new DotStuffEncoder();
		encoder.final();
		expect(() => encoder.transform(Buffer.from('x'))).toThrow();
	});

	it('throws if final is called twice', () => {
		const encoder = new DotStuffEncoder();
		encoder.final();
		expect(() => encoder.final()).toThrow();
	});
});
