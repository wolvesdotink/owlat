/**
 * Find in conversation's matching policy and marks:
 *   - literal, case-insensitive, normalized like grounding's quotes;
 *   - matches do not overlap;
 *   - marks run across inline markup, the active one stands out, and only
 *     find's own marks are cleared (a cited quote's mark stays);
 *   - the index text of a rendered body knows where its quoted chain starts,
 *     through the render pipeline's marked divider.
 */
import { describe, expect, it } from 'vitest';
import {
	clearPostboxFindMarks,
	countPostboxFindMatches,
	markPostboxFindMatches,
	postboxFindNeedle,
	postboxFindOccurrences,
	postboxFindTextOf,
} from '../postboxFindHighlights';
import { highlightQuote } from '../postboxQuoteHighlight';
import { renderPostboxBodyStage, POSTBOX_QUOTE_DIVIDER_ATTR } from '../postboxRenderPipeline';

function doc(html: string): Document {
	const d = document.implementation.createHTMLDocument('body');
	d.body.innerHTML = html;
	return d;
}
const marks = (d: Document) =>
	[...d.querySelectorAll('mark[data-owlat-find]')].map((m) => m.textContent).join('|');
const activeText = (d: Document) =>
	[...d.querySelectorAll('mark[data-owlat-find-active]')].map((m) => m.textContent).join('');

describe('postboxFindNeedle', () => {
	it('folds case and normalizes like a quote, keeping punctuation literal', () => {
		expect(postboxFindNeedle('  Invoice   4471 ')).toBe('invoice 4471');
		expect(postboxFindNeedle('$5.00 (net)')).toBe('$5.00 (net)');
		expect(postboxFindNeedle('“Refund”')).toBe('"refund"');
		// NFKC: the ligature and the full-width digits read as plain text.
		expect(postboxFindNeedle('ﬁle ４４７１')).toBe('file 4471');
		expect(postboxFindNeedle('   ')).toBe('');
	});
});

describe('postboxFindOccurrences', () => {
	it('finds every start, left to right, without overlapping', () => {
		expect(postboxFindOccurrences('aaaa', 'aa')).toEqual([0, 2]);
		expect(postboxFindOccurrences('a.b a.b', 'a.b')).toEqual([0, 4]);
		// Not a pattern: the dot only matches a dot.
		expect(postboxFindOccurrences('axb', 'a.b')).toEqual([]);
		expect(postboxFindOccurrences('anything', '')).toEqual([]);
	});
});

describe('markPostboxFindMatches', () => {
	it('marks every match across inline markup and stands the active one out', () => {
		const d = doc('<p>Refund the <b>dup</b>licate. The duplicate refund is due.</p>');
		const result = markPostboxFindMatches(d, postboxFindNeedle('duplicate'), 1);
		expect(result.count).toBe(2);
		expect(marks(d)).toBe('dup|licate|duplicate');
		expect(activeText(d)).toBe('duplicate');
		expect(result.active?.textContent).toBe('duplicate');
		// The text reads exactly as before.
		expect(d.body.textContent).toBe('Refund the duplicate. The duplicate refund is due.');
	});

	it('matches case-insensitively and through typographic quotes', () => {
		const d = doc('<p>She wrote “REFUND please” twice: refund please.</p>');
		expect(markPostboxFindMatches(d, postboxFindNeedle('"refund please"'), 0).count).toBe(1);
		expect(markPostboxFindMatches(d, postboxFindNeedle('Refund Please'), null).count).toBe(2);
		expect(activeText(d)).toBe('');
	});

	it('marks literal regex punctuation as written', () => {
		const d = doc('<p>Total $5.00 (net), not $5x00 net.</p>');
		expect(markPostboxFindMatches(d, postboxFindNeedle('$5.00 (net)'), 0).count).toBe(1);
		expect(marks(d)).toBe('$5.00 (net)');
	});

	it('skips hidden text and a withheld image stand-in', () => {
		const d = doc(
			'<p>refund</p><p style="display:none">refund</p><span data-blocked-img="https://x.example/i.png">refund</span>'
		);
		expect(markPostboxFindMatches(d, postboxFindNeedle('refund'), 0).count).toBe(1);
	});

	it('re-marks from scratch and clears only its own marks, never a cited quote', () => {
		const d = doc('<p>Please confirm the refund by Friday.</p>');
		expect(highlightQuote(d, { quote: 'confirm the refund' }).status).toBe('marked');
		markPostboxFindMatches(d, postboxFindNeedle('refund'), 0);
		markPostboxFindMatches(d, postboxFindNeedle('refund'), 0);
		expect(d.querySelectorAll('mark[data-owlat-find]')).toHaveLength(1);
		expect(d.querySelector('mark[data-owlat-cite]')?.textContent).toBe('confirm the refund');
		clearPostboxFindMarks(d);
		expect(d.querySelectorAll('mark[data-owlat-find]')).toHaveLength(0);
		expect(d.querySelector('mark[data-owlat-cite]')?.textContent).toBe('confirm the refund');
		expect(d.body.textContent).toBe('Please confirm the refund by Friday.');
	});

	it('marks a glyph two matches share once, counting both and keeping the active one', () => {
		// NFKC reads `ﬃ` as `ffi`: two matches of `f` on one source unit.
		for (const active of [0, 1]) {
			const d = doc('<p>oﬃce</p>');
			const result = markPostboxFindMatches(d, postboxFindNeedle('f'), active);
			expect(result.count).toBe(2);
			expect(marks(d)).toBe('ﬃ');
			expect(activeText(d)).toBe('ﬃ');
			expect(result.active?.textContent).toBe('ﬃ');
			expect(d.body.textContent).toBe('oﬃce');
		}
		const d = doc('<p>oﬃce</p>');
		expect(markPostboxFindMatches(d, postboxFindNeedle('f'), null).count).toBe(2);
		expect(activeText(d)).toBe('');
	});

	it('splits matches that overlap on part of their source into shared and own marks', () => {
		// `fﬀf` reads as `ffff`: `ff` matches `fﬀ` and `ﬀf`, sharing the `ﬀ`.
		const d = doc('<p>xfﬀfx</p>');
		const result = markPostboxFindMatches(d, postboxFindNeedle('ff'), 1);
		expect(result.count).toBe(2);
		expect(marks(d)).toBe('f|ﬀ|f');
		expect(activeText(d)).toBe('ﬀf');
		// The active match's first mark is the shared glyph: it starts there.
		expect(result.active?.textContent).toBe('ﬀ');
		expect(d.body.textContent).toBe('xfﬀfx');
		markPostboxFindMatches(d, postboxFindNeedle('ff'), 0);
		expect(activeText(d)).toBe('fﬀ');
	});

	it('marks nothing for an empty needle', () => {
		const d = doc('<p>refund</p>');
		expect(markPostboxFindMatches(d, '', 0)).toEqual({ count: 0, active: null });
	});
});

describe('postboxFindTextOf', () => {
	const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
	const render = (html: string) =>
		renderPostboxBodyStage({
			html,
			text: '',
			showQuoted: true,
			scheme: 'light',
			cidUrls: new Map(),
			markQuoteDivider: true,
		}).html;

	it('knows where the quoted chain starts in a rendered body', () => {
		const html = render(
			'<p>Refund is on its way.</p><blockquote type="cite"><p>Could you refund the second charge?</p></blockquote>'
		);
		const text = postboxFindTextOf(parse(html));
		expect(text.text.slice(0, text.quotedFrom).trim()).toBe('refund is on its way.');
		expect(countPostboxFindMatches(text, postboxFindNeedle('refund'))).toEqual({
			total: 2,
			fresh: 1,
		});
		expect(countPostboxFindMatches(text, postboxFindNeedle('second'))).toEqual({
			total: 1,
			fresh: 0,
		});
	});

	it('reads a body with no quote as all fresh', () => {
		const text = postboxFindTextOf(parse(render('<p>Refund, refund.</p>')));
		expect(text.quotedFrom).toBe(text.text.length);
		expect(countPostboxFindMatches(text, postboxFindNeedle('refund'))).toEqual({
			total: 2,
			fresh: 2,
		});
	});

	it('leaves the divider of the body the reader shows unmarked', () => {
		const input = {
			html: '<p>Hi</p><blockquote type="cite"><p>quoted</p></blockquote>',
			text: '',
			showQuoted: true,
			scheme: 'light' as const,
			cidUrls: new Map<string, string>(),
		};
		expect(renderPostboxBodyStage(input).html).not.toContain(POSTBOX_QUOTE_DIVIDER_ATTR);
		expect(renderPostboxBodyStage({ ...input, markQuoteDivider: true }).html).toContain(
			POSTBOX_QUOTE_DIVIDER_ATTR
		);
	});

	it('cannot be fooled by mail that carries the divider attribute itself', () => {
		const html = render(
			`<p>Hello <span ${POSTBOX_QUOTE_DIVIDER_ATTR}="">refund</span> now.</p><blockquote type="cite"><p>refund</p></blockquote>`
		);
		const text = postboxFindTextOf(parse(html));
		expect(countPostboxFindMatches(text, postboxFindNeedle('refund'))).toEqual({
			total: 2,
			fresh: 1,
		});
	});
});
