import { describe, it, expect } from 'vitest';
import { sanitizeEditorHtml, sanitizeRawHtml } from '../sanitize';

// Markup the builder's editors produce for ordinary formatting, written the
// way sanitize-html serializes it, so a round trip must return it unchanged.
const LEGITIMATE = [
	'<p><strong>Bold</strong> <em>italic</em> <b>b</b> <i>i</i> <u>under</u> <s>struck</s> <strike>old</strike></p>',
	'<p><a href="https://example.com/path?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">link</a> ',
	'<a href="mailto:hello@example.com">mail</a> <a href="{{unsubscribeUrl}}">unsubscribe</a></p>',
	'<ul><li>one</li><li><strong>two</strong></li></ul><ol><li>first</li></ol>',
	'<p style="text-align:center"><span style="color:#ff0000">red</span> ',
	'<span style="background-color:rgb(255, 255, 0)">marked</span> ',
	'<span style="font-size:18px;font-weight:bold">big</span></p>',
	'<h2>Heading</h2><p>line<br />break</p>',
	'<p>Hi <span class="variable-tag" contenteditable="false" data-variable="firstName">{{firstName}}</span></p>',
].join('');

describe('sanitizeEditorHtml — legitimate formatting round-trips', () => {
	it('returns representative editor HTML unchanged', () => {
		expect(sanitizeEditorHtml(LEGITIMATE)).toBe(LEGITIMATE);
	});

	it('is idempotent', () => {
		const once = sanitizeEditorHtml('<p>a<br>b &nbsp;<a href="https://x.test">x</a></p>');
		expect(sanitizeEditorHtml(once)).toBe(once);
	});

	it('returns an empty string for empty input', () => {
		expect(sanitizeEditorHtml('')).toBe('');
	});
});

describe('sanitizeEditorHtml — unsafe content', () => {
	it.each([
		['<img src="x" onerror="window.__x=1">', 'onerror'],
		['<a href="javascript:alert(1)">x</a>', 'javascript:'],
		['<a href="  JaVaScRiPt:alert(1)">x</a>', 'alert'],
		['<a href="data:text/html,hi">x</a>', 'data:'],
		['<a href="vbscript:msgbox(1)">x</a>', 'vbscript:'],
		['<script>alert(1)</script>', 'alert'],
		['<svg><script>alert(1)</script></svg>', 'script'],
		['<iframe src="https://x.test"></iframe>', 'iframe'],
		['<span style="position:fixed;color:red">x</span>', 'position'],
		['<span data-other="1">x</span>', 'data-other'],
		['<span contenteditable="true">x</span>', 'contenteditable'],
		['<p contenteditable="false">x</p>', 'contenteditable'],
	])('removes %s', (input, marker) => {
		expect(sanitizeEditorHtml(input)).not.toContain(marker);
	});

	it('never lets more through than the raw-HTML policy, apart from the editor additions', () => {
		const input =
			'<a href="https://x.test" onclick="x()">a</a><form><input></form><style>p{}</style>';
		expect(sanitizeEditorHtml(input)).toBe(sanitizeRawHtml(input));
	});
});
