import { describe, it, expect } from 'vitest';
import { trimTrailingBlankBlocks } from '../postboxBodyTidy';

describe('trimTrailingBlankBlocks', () => {
	it("drops Outlook's trailing spacer paragraphs but keeps the closing tags", () => {
		const html =
			'<div class="WordSection1"><p class="MsoNormal">Best, Ines</p>' +
			'<p class="MsoNormal"> </p><p class="MsoNormal"><span style="font-size:12pt">&nbsp;</span></p>\n</div>';
		expect(trimTrailingBlankBlocks(html)).toBe(
			'<div class="WordSection1"><p class="MsoNormal">Best, Ines</p></div>'
		);
	});

	it('drops trailing <br>s and empty divs', () => {
		expect(trimTrailingBlankBlocks('<div>Thanks</div><div><br></div><br><br />')).toBe(
			'<div>Thanks</div>'
		);
	});

	it('keeps blank lines between content', () => {
		const html = '<p>One</p><p>&nbsp;</p><p>Two</p>';
		expect(trimTrailingBlankBlocks(html)).toBe(html);
	});

	it('keeps a trailing block that holds text or an image', () => {
		expect(trimTrailingBlankBlocks('<p>Hi</p><p><span>Ines</span></p>')).toBe(
			'<p>Hi</p><p><span>Ines</span></p>'
		);
		expect(trimTrailingBlankBlocks('<p>Hi</p><p><img src="cid:logo"></p>')).toBe(
			'<p>Hi</p><p><img src="cid:logo"></p>'
		);
	});

	it('only looks at the tail of a long body', () => {
		const long = `<p>${'x'.repeat(10_000)}</p><p>&nbsp;</p>`;
		expect(trimTrailingBlankBlocks(long)).toBe(`<p>${'x'.repeat(10_000)}</p>`);
	});
});
