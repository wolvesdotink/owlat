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
		// 38 + 3 emoji is 41 characters but 44 UTF-16 units: a unit cut at 39
		// would split the first owl.
		const payload = chatPayload(
			{
				roomId: 'r1',
				authorName: `${'b'.repeat(38)}🦉🦉🦉`,
				roomName: '#general',
				text: 'hi',
				url: '/dashboard/chat/r1',
			},
			'en',
			false
		);
		expect(payload.title).toBe(`${'b'.repeat(38)}🦉… in #general`);
	});

	describe('a sign-in code', () => {
		const CODE = { ...MAIL, subject: '482913 is your Northwind code', hasSignInCode: true };
		const COPY_URL = '/dashboard/postbox/inbox/m1?mailbox=b1&signInCode=copy';

		it('gets a Copy code button that opens the message to copy it', () => {
			expect(mailPayload(CODE, 'en', false).actions).toEqual([
				{ action: 'copy-code', title: 'Copy code', url: COPY_URL },
			]);
			expect(mailPayload(CODE, 'de', false).actions?.[0]?.title).toBe('Code kopieren');
		});

		it('keeps the button but not the code when previews are private', () => {
			const payload = mailPayload(CODE, 'en', true);
			expect(payload.actions?.map((action) => action.url)).toEqual([COPY_URL]);
			expect(JSON.stringify(payload)).not.toContain('482913');
		});

		it('gives a sealed message and mail without a code no button', () => {
			expect(mailPayload({ ...CODE, isSealed: true }, 'en', false).actions).toBeUndefined();
			expect(mailPayload(MAIL, 'en', false).actions).toBeUndefined();
		});
	});
});
