/**
 * Unit coverage for `composeMessage` surfaces that the differential harness does
 * NOT exercise (they have no nodemailer analogue, or are deliberately kept out of
 * the "clean input" differential corpus): the returned envelope, extra-header
 * injection stripping, structural-header collision dropping, and Bcc handling.
 */

import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
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

describe('composeMessage CRLF header-injection defence', () => {
	it('strips CRLF from an attacker-controlled Message-ID (reply flows)', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<x@y>\r\nBcc: leak@evil.test',
		});
		const eml = raw.toString('utf-8');
		// The CRLF is collapsed to a single space, so the injected `Bcc:` never
		// begins a physical line — nothing parses as a smuggled header. The
		// `leak@evil.test` text survives, folded onto the Message-ID's own line;
		// that it is inert (not a header) is exactly what line 103 + the exact
		// neutralized line below assert.
		expect(eml).not.toMatch(/^Bcc:/im);
		expect(eml).toMatch(/^Message-ID: <x@y> Bcc: leak@evil\.test\r$/m);
	});

	it('strips CRLF from In-Reply-To and References (derived from inbound Message-IDs)', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			inReplyTo: '<parent@x>\r\nX-Injected: a',
			references: '<root@x>\r\nX-Injected2: b',
		});
		const eml = raw.toString('utf-8');
		expect(eml).not.toMatch(/^X-Injected:/im);
		expect(eml).not.toMatch(/^X-Injected2:/im);
	});

	it('strips CRLF from an attachment Content-Type and CRLF/brackets from its Content-ID', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			html: '<p>x <img src="cid:logo"></p>',
			attachments: [
				{
					filename: 'logo.png',
					contentType: 'image/png\r\nX-Smuggled: evil',
					isInline: true,
					contentId: 'logo>\r\nX-Also: evil',
					data: Buffer.from([1, 2, 3]),
				},
			],
		});
		const eml = raw.toString('utf-8');
		expect(eml).not.toMatch(/^X-Smuggled:/im);
		expect(eml).not.toMatch(/^X-Also:/im);
		// Content-ID keeps a single, well-formed angle-bracket pair.
		expect(eml).toMatch(/^Content-ID: <logoX-Also: evil>\r$/m);
	});
});

describe('composeMessage envelope dedupe (nodemailer getEnvelope semantics)', () => {
	it('dedupes a recipient listed in both To and Cc (first-seen order)', () => {
		const { envelope } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			to: ['a@x.test', 'Bob <b@x.test>'],
			cc: ['a@x.test', 'c@x.test'],
			bcc: ['b@x.test'],
		});
		expect(envelope.to).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
	});

	it('strips CRLF from an explicit envelope override', () => {
		const { envelope } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			envelope: { from: 'from@x.test\r\nEVIL', to: ['to@x.test\r\nEVIL'] },
		});
		expect(envelope.from).toBe('from@x.testEVIL');
		expect(envelope.to).toEqual(['to@x.testEVIL']);
	});
});

describe('composeMessage msg-id list folding (998-octet hard cap)', () => {
	// A realistic long thread: ~15 accumulated msg-ids whose single-line
	// References value comfortably exceeds the RFC 5322 §2.1.1 998-octet cap.
	const ids = Array.from(
		{ length: 15 },
		(_, i) =>
			`<message-${String(i).padStart(4, '0')}-padding-to-widen-this-token-well-beyond-half-the-cap@thread.mail.example.test>`
	);
	const references = ids.join(' ');

	it('folds References on the FWS between ids so no physical line exceeds 998 octets', async () => {
		const { raw } = composeMessage({ ...BASE, messageId: '<id@owlat.test>', references });
		const eml = raw.toString('utf-8');
		// Sanity: the single-line form would have blown the cap.
		expect('References: '.length + references.length).toBeGreaterThan(998);
		for (const line of eml.split('\r\n')) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(998);
		}
		// mailparser round-trips the identical id list (folding is transparent).
		const parsed = await simpleParser(raw);
		const got = Array.isArray(parsed.references)
			? parsed.references
			: parsed.references
				? [parsed.references]
				: [];
		// Normalize away any angle brackets mailparser may or may not strip, then
		// assert the exact id list survives folding in order.
		const strip = (s: string) => s.replace(/^<|>$/g, '');
		expect(got.map(strip)).toEqual(ids.map(strip));
	});

	it('folds In-Reply-To against its own prefix', async () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			inReplyTo: references,
		});
		const eml = raw.toString('utf-8');
		for (const line of eml.split('\r\n')) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(998);
		}
		const parsed = await simpleParser(raw);
		const got = Array.isArray(parsed.inReplyTo)
			? parsed.inReplyTo
			: parsed.inReplyTo
				? [parsed.inReplyTo]
				: [];
		// mailparser exposes inReplyTo as the raw folded value; assert the ids survive.
		const joined = got.join(' ');
		for (const id of ids) expect(joined).toContain(id);
	});
});

describe('composeMessage boundary safety', () => {
	it('rejects a boundarySeed with unsafe characters', () => {
		expect(() => composeMessage({ ...BASE, boundarySeed: 'bad seed"' })).toThrow(/boundarySeed/);
	});

	it('rejects a boundarySeed longer than the 40-char cap', () => {
		expect(() => composeMessage({ ...BASE, boundarySeed: 'x'.repeat(41) })).toThrow(/boundarySeed/);
	});

	it('throws when a body line collides with a seeded boundary delimiter', () => {
		expect(() =>
			composeMessage({
				...BASE,
				boundarySeed: 'collide',
				// The seeded alternative boundary VALUE is `--_owlat_collide_0`, so its
				// on-wire delimiter line is `--` + that value.
				text: 'harmless\r\n----_owlat_collide_0\r\nsmuggled',
				html: '<p>x</p>',
			})
		).toThrow(/boundary collision/);
	});
});

describe('composeMessage extra-header name sanitisation', () => {
	it('restricts header names to RFC 5322 ftext (drops spaces / non-ASCII)', () => {
		const { raw } = composeMessage({
			...BASE,
			messageId: '<id@owlat.test>',
			headers: { 'X Owlat': 'a', 'X-Grüße': 'b' },
		});
		const eml = raw.toString('utf-8');
		expect(eml).toMatch(/^XOwlat: a\r$/m);
		expect(eml).toMatch(/^X-Gre: b\r$/m);
	});
});

describe('composeMessage empty subject', () => {
	it('emits the empty subject as-is (no invented placeholder)', () => {
		const { raw } = composeMessage({ ...BASE, subject: '', messageId: '<id@owlat.test>' });
		const headerBlock = raw.toString('utf-8').split('\r\n\r\n')[0]!;
		expect(headerBlock).toMatch(/^Subject: \r$/m);
		expect(headerBlock).not.toContain('(no subject)');
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
