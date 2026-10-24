/**
 * The mail text size has to reach every run of text in a body, not only the
 * text that inherits the base size. Plain replies are full of fixed sizes: a
 * `<span style="font-size:12px">` signature, Outlook's 11pt `MsoNormal`
 * paragraphs (restored by the base style). A size setting that grows the
 * inherited text and leaves those alone makes a reply read in two sizes.
 *
 * Rendered through the cascade rather than asserted on the CSS string: the
 * real classifier picks the kind, the real base style is applied to a
 * document, and the effective size of each element is its computed font size
 * times the zoom of it and its ancestors.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildBaseStyle } from '../postboxBaseStyle';
import { adaptEmailHtml } from '../postboxDarkMode';
import { MAIL_TEXT_PX, type MailTextSize } from '../readingComfort';

const REPLY =
	'<p id="inherited">Thanks, that works for me.</p>' +
	'<p class="MsoNormal" id="outlook">Sent from Outlook</p>' +
	'<p><span id="inline" style="font-size:12px">Jane Doe, example.com</span></p>';

const SIZES: readonly MailTextSize[] = ['small', 'default', 'large', 'larger'];
const IDS = ['inherited', 'outlook', 'inline'] as const;

function zoomOf(el: Element): number {
	const value = parseFloat(getComputedStyle(el).getPropertyValue('zoom'));
	return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Rendered text size of each element: computed font size times every zoom above it. */
function renderedSizes(textSize: MailTextSize): Record<(typeof IDS)[number], number> {
	const { html, scheme, kind } = adaptEmailHtml(REPLY, 'light');
	expect(kind).toBe('simple');
	document.head.innerHTML = buildBaseStyle(scheme, kind, { textSize, readingWidth: 'default' });
	document.body.innerHTML = html;
	const sizes = {} as Record<(typeof IDS)[number], number>;
	for (const id of IDS) {
		const el = document.getElementById(id)!;
		let scale = 1;
		for (let node: Element | null = el; node; node = node.parentElement) scale *= zoomOf(node);
		sizes[id] = parseFloat(getComputedStyle(el).fontSize) * scale;
	}
	return sizes;
}

afterEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
});

describe('mail text size in rendered simple mail', () => {
	it('keeps the default rendering: 15px body text, the inline and Outlook sizes as sent', () => {
		const sizes = renderedSizes('default');
		expect(sizes.inherited).toBe(15);
		expect(sizes.inline).toBe(12);
		// 11pt; the exact px value is the engine's pt conversion.
		expect(sizes.outlook).toBeGreaterThan(14);
		expect(sizes.outlook).toBeLessThan(15);
	});

	it('grows inline-sized and Outlook text by the same ratio as the body text', () => {
		const base = renderedSizes('default');
		for (const textSize of SIZES) {
			const ratio = MAIL_TEXT_PX[textSize] / MAIL_TEXT_PX.default;
			const sizes = renderedSizes(textSize);
			for (const id of IDS) {
				expect(sizes[id], `${id} at ${textSize}`).toBeCloseTo(base[id] * ratio, 1);
			}
		}
	});
});
