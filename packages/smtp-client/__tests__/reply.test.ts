import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReply, parseReplyLine, ReplyParser } from '../src/reply';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

function fixture(name: string): string {
	return readFileSync(join(fixturesDir, name), 'utf8');
}

/** Re-emit a fixture with CRLF endings, exactly as a socket would deliver it. */
function asWire(name: string): string {
	return fixture(name).replace(/\r?\n/g, '\r\n');
}

describe('greeting fixtures (real transcripts)', () => {
	const greetings: Array<[string, string]> = [
		['gmail', 'gmail-greeting.txt'],
		['outlook', 'outlook-greeting.txt'],
		['postfix', 'postfix-greeting.txt'],
		['exim', 'exim-greeting.txt'],
	];

	for (const [name, file] of greetings) {
		it(`parses the ${name} greeting as a single-line 220`, () => {
			const reply = parseReply(fixture(file));
			expect(reply.code).toBe(220);
			expect(reply.lines).toHaveLength(1);
			expect(reply.enhancedCode).toBeUndefined();
		});
	}
});

describe('multiline EHLO fixtures (real transcripts)', () => {
	const cases: Array<[string, string, number]> = [
		['gmail', 'gmail-ehlo.txt', 8],
		['outlook', 'outlook-ehlo.txt', 10],
		['postfix', 'postfix-ehlo.txt', 11],
		['exim', 'exim-ehlo.txt', 7],
	];

	for (const [name, file, lineCount] of cases) {
		it(`parses the ${name} EHLO continuation into a 250 reply`, () => {
			const reply = parseReply(asWire(file));
			expect(reply.code).toBe(250);
			expect(reply.lines).toHaveLength(lineCount);
		});
	}
});

describe('enhanced status code extraction (RFC 3463)', () => {
	it('extracts the X.Y.Z code and strips it from the text', () => {
		const reply = parseReply(asWire('enhanced-rcpt-reject.txt'));
		expect(reply.code).toBe(550);
		expect(reply.enhancedCode).toBe('5.1.1');
		expect(reply.lines[0]).toBe('The email account that you tried to reach does not exist.');
	});

	it('leaves enhancedCode undefined when no enhanced code is present', () => {
		const reply = parseReply('250 OK');
		expect(reply.enhancedCode).toBeUndefined();
		expect(reply.lines[0]).toBe('OK');
	});
});

describe('parseReplyLine tolerance', () => {
	it('treats a hyphen separator as a continuation line', () => {
		expect(parseReplyLine('250-mail.example')?.final).toBe(false);
	});

	it('treats a space separator as the final line', () => {
		expect(parseReplyLine('250 done')?.final).toBe(true);
	});

	it('tolerates a missing separator (runs the text on) as final', () => {
		const parsed = parseReplyLine('250');
		expect(parsed?.code).toBe(250);
		expect(parsed?.final).toBe(true);
	});

	it('tolerates leading whitespace before the code', () => {
		expect(parseReplyLine('   354 go ahead')?.code).toBe(354);
	});

	it('returns undefined for a line without a leading 3-digit code', () => {
		expect(parseReplyLine('not an smtp line')).toBeUndefined();
	});
});

describe('ReplyParser streaming', () => {
	it('assembles a multiline reply that arrives across chunk boundaries', () => {
		const parser = new ReplyParser();
		expect(parser.push('250-mail.exa')).toEqual([]);
		expect(parser.push('mple\r\n250-SIZE 100')).toEqual([]);
		const replies = parser.push('00\r\n250 HELP\r\n');
		expect(replies).toHaveLength(1);
		expect(replies[0]?.code).toBe(250);
		expect(replies[0]?.lines).toEqual(['mail.example', 'SIZE 10000', 'HELP']);
		expect(parser.hasPending).toBe(false);
	});

	it('emits a greeting and an EHLO reply as two separate replies', () => {
		const parser = new ReplyParser();
		const wire = asWire('gmail-greeting.txt') + asWire('gmail-ehlo.txt');
		const replies = parser.push(wire);
		expect(replies).toHaveLength(2);
		expect(replies[0]?.code).toBe(220);
		expect(replies[1]?.code).toBe(250);
	});

	it('reports pending while a reply is mid-arrival', () => {
		const parser = new ReplyParser();
		parser.push('250-first\r\n');
		expect(parser.hasPending).toBe(true);
	});
});
