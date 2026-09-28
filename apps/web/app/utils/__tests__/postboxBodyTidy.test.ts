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

	it('drops spacers holding raw U+00A0, the form sanitize-html emits for &nbsp;', () => {
		expect(trimTrailingBlankBlocks('<p>Hi</p><p>  </p>')).toBe('<p>Hi</p>');
	});

	it('stays fast on a trailing block of nbsp that ends in text', () => {
		// Overlapping alternatives made this backtrack exponentially: 32 nbsp
		// took ~18 s in V8, and every two more roughly quadrupled it.
		const hostile = `<p>Hi</p><p>${' '.repeat(4000)}x</p>`;
		const started = performance.now();
		expect(trimTrailingBlankBlocks(hostile)).toBe(hostile);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it('only looks at the tail of a long body', () => {
		const long = `<p>${'x'.repeat(10_000)}</p><p>&nbsp;</p>`;
		expect(trimTrailingBlankBlocks(long)).toBe(`<p>${'x'.repeat(10_000)}</p>`);
	});
});
