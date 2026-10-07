// @vitest-environment happy-dom
/**
 * A cited quote marked in a rendered body (plan §4.2):
 *   - found in the visible text across inline markup and typographic quotes;
 *   - repeated wording: the evidence's occurrence picks the passage, never
 *     the first match;
 *   - no guessing: an unknown occurrence over repeated words, or fewer matches
 *     than the occurrence, marks nothing and says why;
 *   - the next cite clears the previous mark.
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
const markedParagraph = (d: Document) =>
	d.querySelector('mark[data-owlat-cite]')?.closest('p')?.getAttribute('id');

describe('highlightQuote', () => {
	it('marks a quote that runs across inline markup', () => {
		const d = doc('<p>With the migration added the quote comes to <b>€5,350</b> instead.</p>');
		const result = highlightQuote(d, { quote: 'the quote comes to €5,350', occurrence: 0 });
		expect(result.status).toBe('marked');
		expect(marked(d)).toBe('the quote comes to |€5,350');
		expect(d.body.textContent).toBe('With the migration added the quote comes to €5,350 instead.');
	});

	it('marks the cited occurrence of repeated wording, not the first', () => {
		const d = doc(
			'<p id="a">Please confirm by Friday.</p><p id="b">Quoted: please confirm by Friday.</p><p id="c">Again, please confirm by Friday.</p>'
		);
		expect(highlightQuote(d, { quote: 'please confirm by Friday', occurrence: 1 }).status).toBe(
			'marked'
		);
		expect(markedParagraph(d)).toBe('c');
		expect(highlightQuote(d, { quote: 'please confirm by Friday', occurrence: 0 }).status).toBe(
			'marked'
		);
		expect(markedParagraph(d)).toBe('b');
	});

	it('does not guess: repeated words without an occurrence, or too few matches', () => {
		const d = doc('<p>please confirm.</p><p>please confirm.</p>');
		expect(highlightQuote(d, { quote: 'please confirm' }).status).toBe('ambiguous');
		expect(highlightQuote(d, { quote: 'please confirm', occurrence: 2 }).status).toBe('notFound');
		expect(marked(d)).toBe('');
		// A unique quote needs no occurrence.
		expect(highlightQuote(doc('<p>only once</p>'), { quote: 'only once' }).status).toBe('marked');
	});

	it('folds whitespace and typographic quotes, but not case (as grounding does)', () => {
		const d = doc('<p>Could you  approve “that”\n by Friday?</p>');
		expect(
			highlightQuote(d, { quote: 'Could you approve "that" by Friday', occurrence: 0 }).status
		).toBe('marked');
		expect(highlightQuote(d, { quote: 'could you approve', occurrence: 0 }).status).toBe(
			'notFound'
		);
	});

	it('reads two paragraphs as two words', () => {
		const d = doc('<p>Best,</p><p>Jonas</p>');
		expect(highlightQuote(d, { quote: 'Best, Jonas', occurrence: 0 }).status).toBe('marked');
	});

	it('clears the previous cite', () => {
		const d = doc('<p>One. Two.</p>');
		highlightQuote(d, { quote: 'One.', occurrence: 0 });
		expect(highlightQuote(d, { quote: 'Three.', occurrence: 0 }).status).toBe('notFound');
		expect(marked(d)).toBe('');
		highlightQuote(d, { quote: 'Two.', occurrence: 0 });
		clearQuoteHighlight(d);
		expect(d.body.innerHTML).toBe('<p>One. Two.</p>');
	});

	it('normalizes the quote like the text', () => {
		expect(normalizeQuote('  a  “b” — c​ ')).toBe('a "b" - c');
	});
});
