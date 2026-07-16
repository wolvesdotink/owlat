/**
 * Unit coverage for `composeMessage` surfaces that the differential harness does
 * NOT exercise (they have no nodemailer analogue, or are deliberately kept out of
 * the "clean input" differential corpus): the returned envelope, extra-header
 * injection stripping, structural-header collision dropping, and Bcc handling.
 */

import { describe, it, expect } from 'vitest';
import { composeMessage } from '../src/index';

const BASE = {
	from: 'sender@owlat.test',
	to: ['rcpt@example.com'],
	subject: 'Test',
	html: '<p>x</p>',
	text: 'x',
	date: new Date('2026-07-11T09:30:00.000Z'),
	boundarySeed: 'unit',
};

describe('composeMessage envelope', () => {
	it('derives the envelope from the header addresses (From addr-spec; To/Cc/Bcc addr-specs)', () => {
		const { envelope } = composeMessage({
			...BASE,
			from: 'Sender Name <sender@owlat.test>',
			to: ['Alice <alice@example.com>'],
			cc: ['bob@example.com'],
			bcc: ['secret@hidden.test'],
			messageId: '<id@owlat.test>',
		});
		expect(envelope.from).toBe('sender@owlat.test');
		expect(envelope.to).toEqual(['alice@example.com', 'bob@example.com', 'secret@hidden.test']);
	});

	it('honours an explicit envelope override (e.g. a VERP return-path)', () => {
		const { envelope } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			envelope: { from: 'bounces.owlat.test@relay.test', to: ['rcpt@example.com'] },
		});
		expect(envelope.from).toBe('bounces.owlat.test@relay.test');
		expect(envelope.to).toEqual(['rcpt@example.com']);
	});
});

describe('composeMessage header safety', () => {
	it('never emits Bcc as a header but keeps it in the envelope', () => {
		const { raw, envelope } = composeMessage({
			...BASE,
			bcc: ['blind@hidden.test'],
			messageId: '<id@owlat.test>',
		});
		const headerBlock = raw.toString('utf-8').split('\r\n\r\n')[0]!;
		expect(headerBlock).not.toMatch(/^Bcc:/im);
		expect(headerBlock).not.toContain('blind@hidden.test');
		expect(envelope.to).toContain('blind@hidden.test');
	});

	it('strips CRLF injection from extra-header names and values', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			headers: {
				'X-Owlat-Note': 'line one\r\nInjected: evil',
				'X-Owlat\r\nSmuggled': 'value',
			},
		});
		const eml = raw.toString('utf-8');
		expect(eml).not.toMatch(/^Injected:/im);
		expect(eml).not.toMatch(/^Smuggled:/im);
		// The sanitized note header survives on a single line.
		expect(eml).toMatch(/^X-Owlat-Note: line one Injected: evil\r$/m);
	});

	it('drops an extra header that collides with a structural header', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			headers: {
				From: 'attacker@evil.test',
				Bcc: 'leak@evil.test',
				'Message-ID': '<forged@evil.test>',
				'X-Owlat-Keep': 'ok',
			},
		});
		const eml = raw.toString('utf-8');
		expect(eml).not.toContain('attacker@evil.test');
		expect(eml).not.toContain('leak@evil.test');
		expect(eml).not.toContain('<forged@evil.test>');
		expect((eml.match(/^Message-ID: /gm) ?? []).length).toBe(1);
		expect(eml).toMatch(/^Message-ID: <id@owlat\.test>\r$/m);
		expect(eml).toMatch(/^X-Owlat-Keep: ok\r$/m);
	});
});

describe('composeMessage body structure', () => {
	it('emits a single text/plain when only text is provided', () => {
		const { raw } = composeMessage({ ...BASE, html: undefined, messageId: '<id@owlat.test>' });
		const eml = raw.toString('utf-8');
		expect(eml).toMatch(/Content-Type: text\/plain; charset=utf-8/);
		expect(eml).not.toContain('multipart/');
	});

	it('emits a single text/html when only html is provided', () => {
		const { raw } = composeMessage({ ...BASE, text: undefined, messageId: '<id@owlat.test>' });
		const eml = raw.toString('utf-8');
		expect(eml).toMatch(/Content-Type: text\/html; charset=utf-8/);
		expect(eml).not.toContain('multipart/');
	});

	it('never emits Content-Transfer-Encoding: 8bit for a unicode body', () => {
		const { raw } = composeMessage({
			...BASE,
			html: '<p>Grüße — café ☕ 🎉</p>',
			text: 'Grüße — café ☕ 🎉',
			messageId: '<id@owlat.test>',
		});
		expect(raw.toString('utf-8')).not.toContain('Content-Transfer-Encoding: 8bit');
	});
});
