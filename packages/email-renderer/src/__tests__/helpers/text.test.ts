/**
 * The renderer's text/plain extraction runs through the shared
 * `htmlToPlainText`, so a block's text part gets the same words every other
 * reader of the message gets, plus the two plain-text mail conventions the
 * renderer adds on top (list bullets, no trailing blanks).
 */
import { describe, it, expect } from 'vitest';
import type { EditorBlock, ListBlockContent } from '@owlat/shared';
import { stripHtml } from '../../helpers/text';
import { diffEmails } from '../../diff';
import { renderPlainText } from '../../plaintext';

describe('stripHtml (renderer text part)', () => {
	it('drops script and style content instead of leaking it into the text part', () => {
		expect(stripHtml('<style>p{color:red}</style><p>Hi</p><script>track()</script>')).toBe('Hi');
	});

	it('decodes an escaped entity once', () => {
		expect(stripHtml('<p>Write &amp;lt;b&amp;gt; for bold</p>')).toBe('Write &lt;b&gt; for bold');
	});

	it('decodes &apos; and numeric references', () => {
		expect(stripHtml('It&apos;s &#8220;done&#x201D;')).toBe("It's “done”");
	});

	it('keeps a bare < that opens no tag', () => {
		expect(stripHtml('<p>a < b and 3 <4</p>')).toBe('a < b and 3 <4');
	});

	it('keeps the block layout: paragraphs, headings, breaks and list bullets', () => {
		expect(stripHtml('<h1>Title</h1><p>One<br>Two</p><ul><li>First</li><li>Second</li></ul>')).toBe(
			'Title\n\nOne\nTwo\n\n  - First\n  - Second'
		);
	});

	it('leaves no trailing blanks and no run of blank lines', () => {
		expect(stripHtml('<p>One &nbsp;</p>\n\n<p>Two \t</p>')).toBe('One\n\nTwo');
	});
});

describe('list block text part', () => {
	it('shows an item as written, the way the html part (which escapes it) does', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'l1',
				type: 'list',
				content: {
					items: ['Press <Enter> to send', 'Tom &amp; Jerry'],
					listType: 'bullet',
				} as ListBlockContent,
			},
		];
		const text = renderPlainText(blocks);
		expect(text).toContain('- Press <Enter> to send');
		expect(text).toContain('- Tom &amp; Jerry');
	});
});

describe('diffEmails text changes', () => {
	it('quotes a changed text block as words, not as entities or script', () => {
		const diff = diffEmails('<p>Tom</p>', '<p>Tom &amp; Jerry<script>x()</script></p>');
		expect(diff.changes.map((change) => change.description)).toContain('Added text: "Tom & Jerry"');
	});
});
