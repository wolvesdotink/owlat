import { describe, it, expect } from 'vitest';
import {
	SHARE_CARD_MAX_BODY_LINES,
	buildShareCard,
	personalDetailTokenIds,
	shareCardBodyText,
	type ShareCard,
} from '../postboxShareCard';

function card(body: string, overrides: Partial<Parameters<typeof buildShareCard>[0]> = {}) {
	return buildShareCard({
		fromName: 'Ben Ortiz',
		fromAddress: 'ben@acmecorp.example',
		date: 'Nov 3, 2026, 08:21',
		subject: 'Invoice #2041',
		body,
		...overrides,
	});
}

const textsOf = (c: ShareCard, ids: Iterable<number>) =>
	[...ids].map((id) => c.tokens[id]?.text).sort();

describe('shareCardBodyText', () => {
	it('reads the HTML part as text when there is one', () => {
		expect(
			shareCardBodyText({ html: '<p>Hello <b>team</b></p><p>Bye</p>', text: 'ignored' })
		).toMatch(/^Hello team\s+Bye$/);
	});

	it('leaves out the quoted history under a reply', () => {
		const text = 'Friday works.\n\nOn Mon, Nov 2, 2026 at 10:00 Ann wrote:\n> Can we meet?';
		expect(shareCardBodyText({ text })).toBe('Friday works.');
	});

	it('keeps a message that is all quote, rather than drawing an empty card', () => {
		expect(shareCardBodyText({ text: '> only a quote' })).toBe('> only a quote');
	});
});

describe('buildShareCard', () => {
	it('numbers every word of every field in reading order', () => {
		const c = card('Hello,\n\nplease re-issue it.');
		expect(c.tokens.map((token) => token.text)).toEqual([
			'Ben',
			'Ortiz',
			'ben@acmecorp.example',
			'Nov',
			'3,',
			'2026,',
			'08:21',
			'Invoice',
			'#2041',
			'Hello,',
			'please',
			're-issue',
			'it.',
		]);
		expect(c.tokens.every((token, i) => token.id === i)).toBe(true);
		const body = c.blocks.find((block) => block.field === 'body');
		// The blank line stays as one paragraph gap.
		expect(body?.lines.map((line) => line.length)).toEqual([1, 0, 3]);
	});

	it('squeezes runs of blank lines and drops a sender name that is not there', () => {
		const c = card('a\n\n\n\nb\n\n', { fromName: '  ' });
		expect(c.blocks.map((block) => block.field)).toEqual(['address', 'date', 'subject', 'body']);
		expect(c.blocks.at(-1)?.lines.map((line) => line.map((token) => token.text))).toEqual([
			['a'],
			[],
			['b'],
		]);
	});

	it('clips a very long body and ends it in an ellipsis', () => {
		const c = card(
			Array.from({ length: SHARE_CARD_MAX_BODY_LINES + 50 }, (_, i) => `l${i}`).join('\n')
		);
		expect(c.truncated).toBe(true);
		const body = c.blocks.at(-1)?.lines ?? [];
		expect(body).toHaveLength(SHARE_CARD_MAX_BODY_LINES + 1);
		expect(body.at(-1)?.[0]?.text).toBe('…');
		expect(card('short').truncated).toBe(false);
	});
});

describe('personalDetailTokenIds', () => {
	it('picks every email address, in the header and the body', () => {
		const c = card('Write to <dana@owlat.example> or billing@acmecorp.example.');
		expect(textsOf(c, personalDetailTokenIds(c))).toEqual([
			'<dana@owlat.example>',
			'ben@acmecorp.example',
			'billing@acmecorp.example.',
		]);
	});

	it('picks a phone number across the words it is written in', () => {
		const c = card('Call me on +49 30 1234567 or (030) 555-0100 today.');
		expect(textsOf(c, personalDetailTokenIds(c))).toEqual(
			['(030)', '+49', '1234567', '30', '555-0100', 'ben@acmecorp.example'].sort()
		);
	});

	it('picks two phone numbers written as one run', () => {
		const c = card('Office 030 12345678 / 040 87654321, ask for Ben.');
		expect(textsOf(c, personalDetailTokenIds(c))).toEqual(
			['/', '030', '040', '12345678', '87654321,', 'ben@acmecorp.example'].sort()
		);
	});

	it('leaves dates, short numbers and the header date alone', () => {
		const c = card('Invoice 2041 from 2026-11-03 and 03.11.2026, suite 300.');
		expect(textsOf(c, personalDetailTokenIds(c))).toEqual(['ben@acmecorp.example']);
	});

	it('picks every word of the person’s own name, whatever its case or punctuation', () => {
		const c = card('Hi Dana, this is for dana weber’s team. Weber: thanks. Danalyn stays.');
		expect(textsOf(c, personalDetailTokenIds(c, 'Dana Weber'))).toEqual(
			['Dana,', 'Weber:', 'ben@acmecorp.example', 'dana', 'weber’s'].sort()
		);
	});

	it('ignores a missing or one-letter name', () => {
		const c = card('A b c');
		expect(textsOf(c, personalDetailTokenIds(c, null))).toEqual(['ben@acmecorp.example']);
		expect(textsOf(c, personalDetailTokenIds(c, 'A'))).toEqual(['ben@acmecorp.example']);
	});
});
