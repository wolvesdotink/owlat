import { describe, expect, it } from 'vitest';
import { chatPayload, mailPayload } from '../copy';

const MAIL = {
	threadId: 't1',
	messageId: 'm1',
	mailboxId: 'b1',
	senderName: 'Alice Example',
	subject: 'Lunch on Friday?',
	isSealed: false,
};

describe('push copy', () => {
	it('flattens line breaks and clips a long subject with an ellipsis', () => {
		const payload = mailPayload(
			{ ...MAIL, subject: `Line one\nline two ${'x'.repeat(300)}` },
			'en',
			false
		);
		expect(payload.body.startsWith('Line one line two ')).toBe(true);
		expect(Array.from(payload.body)).toHaveLength(160);
		expect(payload.body.endsWith('…')).toBe(true);
	});

	it('never cuts an emoji in half', () => {
		// 158 ASCII characters put a UTF-16 cut right through the first emoji's
		// surrogate pair.
		const subject = `${'a'.repeat(158)}🦉🦉🦉🦉`;
		const { body } = mailPayload({ ...MAIL, subject }, 'en', false);
		expect(body).toBe(`${'a'.repeat(158)}🦉…`);
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body)).toBe(false);
	});

	it('clips a chat author and room by characters too', () => {
		const payload = chatPayload(
			{
				roomId: 'r1',
				authorName: `${'b'.repeat(39)}🦉🦉`,
				roomName: '#general',
				text: 'hi',
				url: '/dashboard/chat/r1',
			},
			'en',
			false
		);
		expect(payload.title).toBe(`${'b'.repeat(39)}… in #general`);
	});
});
