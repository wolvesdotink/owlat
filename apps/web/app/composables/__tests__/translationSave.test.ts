import { describe, it, expect } from 'vitest';
import {
	buildLanguageAdd,
	buildTranslationUpdate,
	translationBaseOf,
	type TranslationBase,
} from '../translationSave';
import type { RenderOptions } from '../useEmailHtmlRendering';

/**
 * The translation table's write (issue #1000): the overlay text and the HTML
 * the send path delivers are built from one frozen row and travel together,
 * named by that row's revision. Rendered with the real email renderer, so the
 * assertions read what a recipient would get.
 */

const renderOptions: RenderOptions = { variableType: 'personalization' };

const CONTENT = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: 'Hello world' } },
	{ id: 'b2', type: 'button', content: { text: 'Click me', url: 'https://example.com' } },
]);

const base = (overrides: Partial<TranslationBase> = {}): TranslationBase => ({
	content: CONTENT,
	subject: 'English subject',
	translations: {
		de: {
			subject: 'Deutscher Betreff',
			previewText: 'Vorschau',
			blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick mich' } },
		},
	},
	revision: 7,
	...overrides,
});

describe('buildTranslationUpdate', () => {
	it('renders the HTML from the edited overlay and names the base revision', () => {
		const payload = buildTranslationUpdate(
			base(),
			'de',
			[{ field: { kind: 'block', blockId: 'b1', property: 'html' }, value: 'Guten Tag' }],
			renderOptions
		);

		expect(payload.expectedContentRevision).toBe(7);
		expect(payload.language).toBe('de');
		expect(payload.subject).toBe('Deutscher Betreff');
		expect(payload.previewText).toBe('Vorschau');
		expect(JSON.parse(payload.blocks)).toEqual({
			b1: { html: 'Guten Tag' },
			b2: { buttonText: 'Klick mich' },
		});
		// The delivery HTML carries the new text and the untouched cells, on the
		// default content's structure; nothing of the old value or the English text.
		expect(payload.htmlContent).toContain('Guten Tag');
		expect(payload.htmlContent).toContain('Klick mich');
		expect(payload.htmlContent).toContain('https://example.com');
		expect(payload.htmlContent).not.toContain('Hallo Welt');
		expect(payload.htmlContent).not.toContain('Hello world');
	});

	it('applies several edits of one language in one payload', () => {
		const payload = buildTranslationUpdate(
			base(),
			'de',
			[
				{ field: { kind: 'subject' }, value: 'Neuer Betreff' },
				{ field: { kind: 'block', blockId: 'b2', property: 'buttonText' }, value: 'Los' },
			],
			renderOptions
		);

		expect(payload.subject).toBe('Neuer Betreff');
		expect(payload.htmlContent).toContain('Los');
		expect(payload.htmlContent).toContain('Hallo Welt');
	});

	it('leaves the base untouched, so a later write is built on the server row', () => {
		const frozen = base();
		const before = JSON.stringify(frozen);

		buildTranslationUpdate(
			frozen,
			'de',
			[{ field: { kind: 'block', blockId: 'b1', property: 'html' }, value: 'Neu' }],
			renderOptions
		);

		expect(JSON.stringify(frozen)).toBe(before);
	});

	it('omits previewText for an overlay without one (transactional emails)', () => {
		const payload = buildTranslationUpdate(
			base({ translations: { de: { subject: 'Betreff', blocks: {} } } }),
			'de',
			[{ field: { kind: 'subject' }, value: 'Neu' }],
			renderOptions
		);

		expect(payload).not.toHaveProperty('previewText');
		// A cell without an overlay value renders the default text.
		expect(payload.htmlContent).toContain('Hello world');
	});
});

describe('buildLanguageAdd', () => {
	it('renders the default content as the seeded language HTML, at the base revision', () => {
		const write = buildLanguageAdd(base({ revision: 3 }), renderOptions);

		expect(write.expectedContentRevision).toBe(3);
		expect(write.htmlContent).toContain('Hello world');
		expect(write.htmlContent).toContain('Click me');
	});
});

describe('translationBaseOf', () => {
	it('freezes the row, reading a missing revision as 0 and bad JSON as no overlays', () => {
		expect(
			translationBaseOf({ content: CONTENT, subject: 'S', translations: '{not json' })
		).toEqual({ content: CONTENT, subject: 'S', translations: {}, revision: 0 });
		expect(
			translationBaseOf({
				content: CONTENT,
				subject: 'S',
				translations: JSON.stringify({ fr: { subject: 'F', blocks: {} } }),
				contentRevision: 12,
			}).revision
		).toBe(12);
	});
});
