import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '@owlat/shared/html';
import { hasHiddenContent } from '../reviewHiddenContent';

const STYLESHEET =
	'<style>.owlat-dark-img{display:none}@media (prefers-color-scheme:dark){.owlat-dark-img{display:block!important}}' +
	'@media only screen and (min-width:481px){.owlat-hide-desktop{display:none!important;max-height:0!important}}' +
	'.owlat-wrap{max-width:600px}</style>';

describe('hasHiddenContent', () => {
	it('finds an element hidden inline, however the style is written', () => {
		for (const style of [
			'display:none',
			'DISPLAY : None !important',
			'visibility:hidden',
			'font-size:0',
			'font-size:0px',
			'font-size:.0em',
			'max-height:0',
			'color:red;max-height:0px;overflow:hidden',
			'mso-hide:all',
		]) {
			expect(hasHiddenContent(`<p style="${style}">x</p>`), style).toBe(true);
		}
		expect(hasHiddenContent('<p hidden>x</p>')).toBe(true);
	});

	it('finds an element whose class the stylesheet hides in some clients or modes', () => {
		expect(hasHiddenContent(`${STYLESHEET}<p class="a owlat-dark-img">x</p>`)).toBe(true);
		expect(hasHiddenContent(`${STYLESHEET}<div class='owlat-hide-desktop'>x</div>`)).toBe(true);
	});

	it('finds nothing in mail that everyone sees whole', () => {
		expect(
			hasHiddenContent(
				`${STYLESHEET}<div class="owlat-wrap" style="font-size:16px;display:block;max-height:none">` +
					'<p style="font-size:0.85em;color:#fff">x</p></div><p>owlat-dark-img</p>'
			)
		).toBe(false);
		// A class the stylesheet only names in a selector of hidden text is not on any element.
		expect(hasHiddenContent(STYLESHEET)).toBe(false);
	});

	it('leaves every hidden line in the text the card shows', () => {
		const html =
			'<p style="display:none">one</p><p style="visibility:hidden">two</p>' +
			'<p style="font-size:0">three</p><p style="color:#fff;background:#fff">four</p>' +
			`${STYLESHEET}<p class="owlat-dark-img">five</p>`;
		const text = htmlToPlainText(html, { preserveBreaks: true });
		for (const line of ['one', 'two', 'three', 'four', 'five']) expect(text).toContain(line);
	});
});
