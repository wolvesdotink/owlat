import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReply } from '../src/reply';
import {
	hasCapability,
	parseEhloCapabilities,
	serializeAuth,
	serializeData,
	serializeEhlo,
	serializeMailFrom,
	serializeQuit,
	serializeRcptTo,
	SmtpCommandInjectionError,
} from '../src/commands';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

function ehloReply(name: string) {
	const raw = readFileSync(join(fixturesDir, name), 'utf8').replace(/\r?\n/g, '\r\n');
	return parseReply(raw);
}

describe('command serializers', () => {
	it('serializes a well-formed MAIL FROM', () => {
		expect(serializeMailFrom('alice@example.com')).toBe('MAIL FROM:<alice@example.com>\r\n');
	});

	it('serializes the null return path for an empty address', () => {
		expect(serializeMailFrom('')).toBe('MAIL FROM:<>\r\n');
	});

	it('serializes MAIL FROM with ESMTP params', () => {
		expect(serializeMailFrom('a@b.com', ['SIZE=1024', 'BODY=7BIT'])).toBe(
			'MAIL FROM:<a@b.com> SIZE=1024 BODY=7BIT\r\n'
		);
	});

	it('serializes RCPT TO and fixed verbs with a trailing CRLF', () => {
		expect(serializeRcptTo('bob@example.com')).toBe('RCPT TO:<bob@example.com>\r\n');
		expect(serializeData()).toBe('DATA\r\n');
		expect(serializeQuit()).toBe('QUIT\r\n');
		expect(serializeEhlo('mta.local')).toBe('EHLO mta.local\r\n');
	});
});

describe('CRLF injection guards throw before serialization', () => {
	const injections = ['\r\n', '\n', '\r', '\r\nRCPT TO:<victim@evil.test>'];

	for (const payload of injections) {
		it(`MAIL FROM rejects injected ${JSON.stringify(payload)}`, () => {
			expect(() => serializeMailFrom(`a@b.com${payload}`)).toThrow(SmtpCommandInjectionError);
		});

		it(`RCPT TO rejects injected ${JSON.stringify(payload)}`, () => {
			expect(() => serializeRcptTo(`a@b.com${payload}`)).toThrow(SmtpCommandInjectionError);
		});

		it(`MAIL FROM param rejects injected ${JSON.stringify(payload)}`, () => {
			expect(() => serializeMailFrom('a@b.com', [`SIZE=1${payload}`])).toThrow(
				SmtpCommandInjectionError
			);
		});
	}

	it('EHLO domain rejects a smuggled newline', () => {
		expect(() => serializeEhlo('mta.local\r\nMAIL FROM:<x@y>')).toThrow(SmtpCommandInjectionError);
	});

	it('AUTH mechanism and initial response reject smuggled newlines', () => {
		expect(() => serializeAuth('PLAIN\r\nDATA')).toThrow(SmtpCommandInjectionError);
		expect(() => serializeAuth('PLAIN', 'AGZvbwB=\r\nDATA')).toThrow(SmtpCommandInjectionError);
	});

	it('rejects ESMTP-parameter smuggling via > and whitespace in the address', () => {
		expect(() => serializeRcptTo('a@b.com> NOTIFY=NEVER')).toThrow(SmtpCommandInjectionError);
		expect(() => serializeMailFrom('a@b.com> AUTH=<>')).toThrow(SmtpCommandInjectionError);
		expect(() => serializeMailFrom('a@b.com SIZE=1')).toThrow(SmtpCommandInjectionError);
		expect(() => serializeRcptTo('<nested@evil.test')).toThrow(SmtpCommandInjectionError);
	});

	it('rejects ASCII control characters in the address', () => {
		expect(() => serializeRcptTo('a@b.com\tX')).toThrow(SmtpCommandInjectionError);
		expect(() => serializeRcptTo('a@b.com\x00')).toThrow(SmtpCommandInjectionError);
	});

	it('never embeds the offending value (credential material) in the error message', () => {
		const secret = 'AGZvbwBzZWNyZXQ='; // base64 credential-shaped token
		let message = '';
		try {
			serializeAuth('PLAIN', `${secret}\r\nDATA`);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).not.toContain(secret);
		expect(message).toContain('AUTH initial-response');
	});

	it('does not serialize any bytes when it throws', () => {
		let serialized: string | undefined;
		try {
			serialized = serializeRcptTo('a@b.com\r\nDATA');
		} catch {
			// expected
		}
		expect(serialized).toBeUndefined();
	});
});

describe('EHLO capability-table parser', () => {
	it('parses Gmail capabilities (SIZE, STARTTLS, SMTPUTF8, no AUTH)', () => {
		const caps = parseEhloCapabilities(ehloReply('gmail-ehlo.txt'));
		expect(caps.size).toBe(157286400);
		expect(caps.startTls).toBe(true);
		expect(caps.smtpUtf8).toBe(true);
		expect(caps.eightBitMime).toBe(true);
		expect(caps.pipelining).toBe(true);
		expect(caps.authMechanisms.size).toBe(0);
	});

	it('parses Exim AUTH mechanisms', () => {
		const caps = parseEhloCapabilities(ehloReply('exim-ehlo.txt'));
		expect([...caps.authMechanisms].sort()).toEqual(['LOGIN', 'PLAIN']);
		expect(caps.size).toBe(52428800);
		expect(caps.startTls).toBe(true);
		expect(caps.smtpUtf8).toBe(false);
	});

	it('parses Outlook capabilities', () => {
		const caps = parseEhloCapabilities(ehloReply('outlook-ehlo.txt'));
		expect(caps.startTls).toBe(true);
		expect(caps.pipelining).toBe(true);
		expect(caps.enhancedStatusCodes).toBe(true);
		expect(hasCapability(caps, 'chunking')).toBe(true);
	});

	it('does NOT treat the greeting/domain line as a capability', () => {
		const caps = parseEhloCapabilities(ehloReply('postfix-ehlo.txt'));
		expect(hasCapability(caps, 'mail.example.org')).toBe(false);
		expect(caps.startTls).toBe(true);
	});

	it('tolerates sloppy servers: old-style AUTH= and lowercase keywords', () => {
		const caps = parseEhloCapabilities(ehloReply('sloppy-ehlo.txt'));
		expect([...caps.authMechanisms].sort()).toEqual(['LOGIN', 'PLAIN']);
		expect(caps.size).toBe(1000000);
	});

	it('exposes the raw keyword table with uppercased keys', () => {
		const caps = parseEhloCapabilities(ehloReply('exim-ehlo.txt'));
		expect(caps.raw.get('HELP')).toEqual([]);
		expect(caps.raw.get('AUTH')).toEqual(['PLAIN', 'LOGIN']);
	});

	it('splits only the first token on = so later args keeping = are preserved', () => {
		const reply = parseReply('250-greeting.example\r\n250 X-TOKEN a=b c=d\r\n');
		const caps = parseEhloCapabilities(reply);
		expect(caps.raw.get('X-TOKEN')).toEqual(['a=b', 'c=d']);
	});
});
