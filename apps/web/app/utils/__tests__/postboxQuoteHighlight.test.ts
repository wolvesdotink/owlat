// @vitest-environment happy-dom
/**
 * A cited quote marked in a rendered body (plan §4.2): found in the visible
 * text across inline markup and typographic quotes, marked once, cleared by
 * the next cite, and absent text marks nothing.
 */
import { describe, expect, it } from 'vitest';
import { clearQuoteHighlight, highlightQuote, normalizeQuote } from '../postboxQuoteHighlight';

function doc(html: string): Document {
	const d = document.implementation.createHTMLDocument('body');
	d.body.innerHTML = html;
	return d;
}
const marked = (d: Document) =>
	[...d.querySelectorAll('mark[data-owlat-cite]')].map((m) => m.textContent).join('|');

describe('highlightQuote', () => {
	it('marks a quote that runs across inline markup', () => {
		const d = doc('<p>With the migration added the quote comes to <b>€5,350</b> instead.</p>');
		const mark = highlightQuote(d, 'the quote comes to €5,350');
		expect(mark?.tagName).toBe('MARK');
		expect(marked(d)).toBe('the quote comes to |€5,350');
		expect(d.body.textContent).toBe('With the migration added the quote comes to €5,350 instead.');
	});

	it('folds whitespace, case and typographic quotes', () => {
		const d = doc('<p>Could you  approve “that”\n by Friday?</p>');
		expect(highlightQuote(d, 'could you approve "that" by friday')).not.toBeNull();
		expect(marked(d)).toBe('Could you  approve “that”\n by Friday');
	});

	it('reads two paragraphs as two words', () => {
		const d = doc('<p>Best,</p><p>Jonas</p>');
		expect(highlightQuote(d, 'Best, Jonas')).not.toBeNull();
	});

	it('clears the previous cite, and marks nothing for a quote that is not there', () => {
		const d = doc('<p>One. Two.</p>');
		highlightQuote(d, 'One.');
		expect(highlightQuote(d, 'Three.')).toBeNull();
		expect(marked(d)).toBe('');
		highlightQuote(d, 'Two.');
		clearQuoteHighlight(d);
		expect(d.body.innerHTML).toBe('<p>One. Two.</p>');
	});

	it('normalizes the quote like the text', () => {
		expect(normalizeQuote('  a  “b” — c ')).toBe('a "b" - c');
	});
});
