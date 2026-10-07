import { describe, it, expect } from 'vitest';
import { APPEND_INLINE_BODY_LIMIT_BYTES, appendEnvelope } from '../envelope.js';

function eml(lines: string[], body = 'Hello body'): Buffer {
	return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body);
}

describe('appendEnvelope', () => {
	it('extracts the standard envelope headers', () => {
		const env = appendEnvelope(
			eml([
				'Message-ID: <abc-123@mail.example>',
				'Subject: Quarterly report',
				'From: Jane Doe <jane@example.com>',
				'To: bob@example.com, carol@example.com',
				'Cc: dave@example.com',
				'Bcc: erin@example.com',
				'Date: Tue, 09 Jun 2026 10:00:00 +0000',
			])
		);
		expect(env.messageId).toBe('abc-123@mail.example');
		expect(env.subject).toBe('Quarterly report');
		expect(env.from).toEqual({ address: 'jane@example.com', name: 'Jane Doe' });
		expect(env.to.map((a) => a.address)).toEqual(['bob@example.com', 'carol@example.com']);
		expect(env.cc.map((a) => a.address)).toEqual(['dave@example.com']);
		expect(env.bcc.map((a) => a.address)).toEqual(['erin@example.com']);
		expect(env.internalDate).toBe(Date.UTC(2026, 5, 9, 10, 0, 0));
		expect(env.text).toBe('Hello body');
		expect(env.html).toBeUndefined();
	});

	it('extracts In-Reply-To with a comment and a folded References chain as bare ids', () => {
		const env = appendEnvelope(
			eml([
				'Message-ID: <reply@mail.example>',
				"In-Reply-To: <parent@example.com> (Jane Doe's message)",
				'References: <root@example.com>',
				' <parent@example.com>',
				'Subject: Re: Quarterly report',
				'From: a@b.com',
				'To: c@d.com',
			])
		);
		expect(env.inReplyTo).toBe('parent@example.com');
		expect(env.references).toEqual(['root@example.com', 'parent@example.com']);
	});

	it('reads a single References id as a one-element list', () => {
		const env = appendEnvelope(
			eml(['References: <root@example.com>', 'From: a@b.com', 'To: c@d.com'])
		);
		expect(env.references).toEqual(['root@example.com']);
	});

	it('reports no threading headers on a fresh message', () => {
		const env = appendEnvelope(eml(['Subject: Hi', 'From: a@b.com', 'To: c@d.com']));
		expect(env.inReplyTo).toBeUndefined();
		expect(env.references).toEqual([]);
	});

	it('falls back to generated ids, a placeholder subject and From when headers are missing', () => {
		const env = appendEnvelope(eml(['To: c@d.com']));
		expect(env.messageId).toMatch(/^append-\d+-[a-z0-9]+$/);
		expect(env.subject).toBe('(no subject)');
		expect(env.from).toEqual({ address: 'unknown@unknown' });
	});

	it('drops an unparseable Date instead of emitting NaN', () => {
		const env = appendEnvelope(eml(['From: a@b.com', 'Date: not a date']));
		expect(env.internalDate).toBeUndefined();
	});

	it('decodes a multipart/alternative message into text and html, without boundary lines', () => {
		const text = Buffer.from('Grüße aus Köln\r\n', 'utf-8').toString('base64');
		const env = appendEnvelope(
			eml(
				[
					'From: a@b.com',
					'To: c@d.com',
					'MIME-Version: 1.0',
					'Content-Type: multipart/alternative; boundary="b1"',
				],
				[
					'--b1',
					'Content-Type: text/plain; charset=utf-8',
					'Content-Transfer-Encoding: base64',
					'',
					text,
					'--b1',
					'Content-Type: text/html; charset=utf-8',
					'Content-Transfer-Encoding: quoted-printable',
					'',
					'<p>Gr=C3=BC=C3=9Fe aus K=C3=B6ln, a long line that is soft-=',
					'wrapped</p>',
					'--b1--',
					'',
				].join('\r\n')
			)
		);
		expect(env.text?.trim()).toBe('Grüße aus Köln');
		expect(env.html?.trim()).toBe('<p>Grüße aus Köln, a long line that is soft-wrapped</p>');
		for (const body of [env.text, env.html]) {
			expect(body).not.toContain('--b1');
			expect(body).not.toContain('Content-Type');
		}
	});

	it('keeps an encoded display name that holds a comma as one From mailbox', () => {
		const env = appendEnvelope(eml(['From: =?UTF-8?Q?Smith=2C_John?= <j@x.com>', 'To: c@d.com']));
		expect(env.from).toEqual({ address: 'j@x.com', name: 'Smith, John' });
	});

	it('does not let a phrase that decodes to an address change the From address', () => {
		const env = appendEnvelope(eml(['From: =?UTF-8?Q?x=40y=2Ecom=2C?= <real@owlat.test>']));
		expect(env.from.address).toBe('real@owlat.test');
		expect(env.from.name).toBe('x@y.com,');
	});

	it('decodes an 8-bit body by its declared charset', () => {
		const raw = Buffer.concat([
			Buffer.from(
				[
					'From: a@b.com',
					'Content-Type: text/plain; charset=iso-8859-1',
					'Content-Transfer-Encoding: 8bit',
					'',
					'',
				].join('\r\n'),
				'latin1'
			),
			Buffer.from('Caf\xe9 cr\xe8me', 'latin1'),
		]);
		expect(appendEnvelope(raw).text).toBe('Café crème');
	});

	it('decodes a UTF-8 8-bit body without mojibake', () => {
		const raw = Buffer.from(
			'From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße',
			'utf-8'
		);
		expect(appendEnvelope(raw).text).toBe('Grüße');
	});

	it('decodes a raw UTF-8 subject and display names (RFC 6532)', () => {
		const env = appendEnvelope(
			eml([
				'Subject: Grüße aus Köln, voilà',
				'From: Jörg Müller <joerg@example.com>',
				'To: Zoë <zoe@example.com>',
			])
		);
		expect(env.subject).toBe('Grüße aus Köln, voilà');
		expect(env.from).toEqual({ address: 'joerg@example.com', name: 'Jörg Müller' });
		expect(env.to).toEqual([{ address: 'zoe@example.com', name: 'Zoë' }]);
	});

	it('keeps an encoded CR/LF out of the subject and display name', () => {
		const env = appendEnvelope(
			eml([
				'Subject: =?UTF-8?Q?Hi=0D=0ABcc=3A_x=40evil.example?=',
				'From: =?UTF-8?Q?Eve=0D=0ABcc=3A_x?= <eve@example.com>',
			])
		);
		expect(env.subject).toBe('Hi Bcc: x@evil.example');
		expect(env.from).toEqual({ address: 'eve@example.com', name: 'Eve Bcc: x' });
	});

	it('caps each inline body to a byte-accurate UTF-8 prefix', () => {
		const long = 'é'.repeat(APPEND_INLINE_BODY_LIMIT_BYTES);
		const raw = Buffer.from(
			`From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${long}`,
			'utf-8'
		);
		const text = appendEnvelope(raw).text!;
		expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(APPEND_INLINE_BODY_LIMIT_BYTES);
		expect(text).toBe('é'.repeat(APPEND_INLINE_BODY_LIMIT_BYTES / 2));
	});
});
