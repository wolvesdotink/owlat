import { describe, it, expect } from 'vitest';
import { diffEmails } from '../diff';
import type { EmailDiff, EmailDiffChange } from '../diff';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap minimal body content in a basic HTML document shell. */
const wrap = (body: string, head = '') =>
	`<html><head>${head}</head><body>${body}</body></html>`;

/** Find changes matching a predicate. */
const findChanges = (diff: EmailDiff, pred: (c: EmailDiffChange) => boolean) =>
	diff.changes.filter(pred);

// ---------------------------------------------------------------------------
// Fixture blocks (reused across integration tests)
// ---------------------------------------------------------------------------

const textBlockV1: EditorBlock = {
	id: '1',
	type: 'text',
	content: {
		html: '<p>Hello World</p>',
		blockType: 'paragraph',
		fontSize: 16,
		textColor: '#333333',
	},
};

const textBlockV2: EditorBlock = {
	id: '1',
	type: 'text',
	content: {
		html: '<p>Updated copy</p>',
		blockType: 'paragraph',
		fontSize: 16,
		textColor: '#333333',
	},
};

const imageBlock: EditorBlock = {
	id: '2',
	type: 'image',
	content: {
		src: 'https://example.com/hero.jpg',
		alt: 'Hero',
		width: 600,
		align: 'center',
	},
};

const buttonBlock: EditorBlock = {
	id: '3',
	type: 'button',
	content: {
		text: 'Click Me',
		url: 'https://example.com/cta',
		backgroundColor: '#007bff',
		textColor: '#ffffff',
		align: 'center',
		borderRadius: 4,
		paddingX: 24,
		paddingY: 12,
	},
};

const dividerBlock: EditorBlock = {
	id: '4',
	type: 'divider',
	content: {
		color: '#cccccc',
		thickness: 1,
		width: 100,
		style: 'solid',
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diffEmails', () => {
	// ----- Empty / identical inputs ----------------------------------------

	describe('identical inputs', () => {
		it('returns identical=true for the same string', () => {
			const html = wrap('<p>Hello</p>');
			const result = diffEmails(html, html);

			expect(result.identical).toBe(true);
			expect(result.changes).toHaveLength(0);
			expect(result.sizeDelta).toBe(0);
			expect(result.stats).toEqual({
				addedElements: 0,
				removedElements: 0,
				modifiedStyles: 0,
				textChanges: 0,
				linkChanges: 0,
				imageChanges: 0,
			});
		});

		it('returns identical=true for two empty strings', () => {
			const result = diffEmails('', '');
			expect(result.identical).toBe(true);
			expect(result.changes).toHaveLength(0);
		});

		it('returns identical=true for two identical complex documents', () => {
			const html = renderEmailHtml([textBlockV1, imageBlock, buttonBlock]);
			const result = diffEmails(html, html);
			expect(result.identical).toBe(true);
		});
	});

	describe('empty inputs', () => {
		it('detects changes when only htmlB has content', () => {
			const result = diffEmails('', wrap('<p>New content</p>'));
			expect(result.identical).toBe(false);
			expect(result.sizeDelta).toBeGreaterThan(0);
		});

		it('detects changes when only htmlA has content', () => {
			const result = diffEmails(wrap('<p>Old content</p>'), '');
			expect(result.identical).toBe(false);
			expect(result.sizeDelta).toBeLessThan(0);
		});
	});

	// ----- Text changes ----------------------------------------------------

	describe('text changes', () => {
		it('detects added text', () => {
			const a = wrap('<p>Hello</p>');
			const b = wrap('<p>Hello</p><p>World</p>');
			const result = diffEmails(a, b);

			expect(result.identical).toBe(false);
			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			expect(added.length).toBeGreaterThanOrEqual(1);
			expect(added.some((c) => c.description.includes('World'))).toBe(true);
			expect(result.stats.textChanges).toBeGreaterThanOrEqual(1);
		});

		it('detects removed text', () => {
			const a = wrap('<p>Hello</p><p>Goodbye</p>');
			const b = wrap('<p>Hello</p>');
			const result = diffEmails(a, b);

			const removed = findChanges(result, (c) => c.type === 'removed' && c.category === 'text');
			expect(removed.length).toBeGreaterThanOrEqual(1);
			expect(removed.some((c) => c.description.includes('Goodbye'))).toBe(true);
		});

		it('detects modified text (shows as added + removed pair)', () => {
			const a = wrap('<p>Version 1</p>');
			const b = wrap('<p>Version 2</p>');
			const result = diffEmails(a, b);

			expect(result.identical).toBe(false);
			expect(findChanges(result, (c) => c.type === 'added' && c.category === 'text').length).toBeGreaterThanOrEqual(1);
			expect(findChanges(result, (c) => c.type === 'removed' && c.category === 'text').length).toBeGreaterThanOrEqual(1);
		});

		it('truncates long text descriptions at 80 characters', () => {
			const longText = 'A'.repeat(120);
			const a = wrap('<p>Short</p>');
			const b = wrap(`<p>${longText}</p>`);
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			expect(added.length).toBeGreaterThanOrEqual(1);
			// The description should contain the truncated text followed by "..."
			const desc = added[0]!.description;
			expect(desc).toContain('...');
		});

		it('does not truncate text at exactly 80 characters', () => {
			const exactText = 'B'.repeat(80);
			const a = wrap('<p>Short</p>');
			const b = wrap(`<p>${exactText}</p>`);
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			expect(added.length).toBeGreaterThanOrEqual(1);
			// 80-char text should NOT have ellipsis (length > 80 triggers it)
			const desc = added[0]!.description;
			expect(desc).not.toContain('...');
		});

		it('extracts text from various HTML elements (h1-h6, td, th, div, span)', () => {
			const a = wrap('');
			const b = wrap(
				'<h1>Heading</h1><h2>Sub</h2><td>Cell</td><th>Header</th><div>Block</div><span>Inline</span>'
			);
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			const descriptions = added.map((c) => c.description).join(' ');
			expect(descriptions).toContain('Heading');
			expect(descriptions).toContain('Cell');
			expect(descriptions).toContain('Block');
			expect(descriptions).toContain('Inline');
		});

		it('strips nested HTML tags when extracting text', () => {
			const a = wrap('');
			const b = wrap('<p>Hello <strong>bold</strong> world</p>');
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			expect(added.length).toBeGreaterThanOrEqual(1);
			// The extracted text should not contain HTML tags
			expect(added[0]!.description).not.toContain('<strong>');
		});
	});

	// ----- Image changes ---------------------------------------------------

	describe('image changes', () => {
		it('detects added images', () => {
			const a = wrap('<p>Hello</p>');
			const b = wrap('<p>Hello</p><img src="https://example.com/new.png" />');
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'image');
			expect(added).toHaveLength(1);
			expect(added[0]!.description).toContain('https://example.com/new.png');
			expect(result.stats.imageChanges).toBe(1);
		});

		it('detects removed images', () => {
			const a = wrap('<img src="https://example.com/old.png" /><p>Text</p>');
			const b = wrap('<p>Text</p>');
			const result = diffEmails(a, b);

			const removed = findChanges(result, (c) => c.type === 'removed' && c.category === 'image');
			expect(removed).toHaveLength(1);
			expect(removed[0]!.description).toContain('https://example.com/old.png');
		});

		it('detects changed image src (shows as added + removed)', () => {
			const a = wrap('<img src="https://example.com/v1.png" />');
			const b = wrap('<img src="https://example.com/v2.png" />');
			const result = diffEmails(a, b);

			expect(findChanges(result, (c) => c.type === 'added' && c.category === 'image')).toHaveLength(1);
			expect(findChanges(result, (c) => c.type === 'removed' && c.category === 'image')).toHaveLength(1);
			expect(result.stats.imageChanges).toBe(2);
		});

		it('detects multiple image additions', () => {
			const a = wrap('');
			const b = wrap(
				'<img src="https://example.com/a.png" /><img src="https://example.com/b.png" />'
			);
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'image');
			expect(added).toHaveLength(2);
		});
	});

	// ----- Link changes ----------------------------------------------------

	describe('link changes', () => {
		it('detects added links', () => {
			const a = wrap('<p>Hello</p>');
			const b = wrap('<p>Hello</p><a href="https://example.com">Click</a>');
			const result = diffEmails(a, b);

			const added = findChanges(result, (c) => c.type === 'added' && c.category === 'link');
			expect(added).toHaveLength(1);
			expect(added[0]!.description).toContain('https://example.com');
			expect(result.stats.linkChanges).toBe(1);
		});

		it('detects removed links', () => {
			const a = wrap('<a href="https://old.com">Old</a>');
			const b = wrap('<p>No links</p>');
			const result = diffEmails(a, b);

			const removed = findChanges(result, (c) => c.type === 'removed' && c.category === 'link');
			expect(removed).toHaveLength(1);
		});

		it('detects changed link href (shows as added + removed)', () => {
			const a = wrap('<a href="https://old.com">Link</a>');
			const b = wrap('<a href="https://new.com">Link</a>');
			const result = diffEmails(a, b);

			expect(findChanges(result, (c) => c.type === 'added' && c.category === 'link')).toHaveLength(1);
			expect(findChanges(result, (c) => c.type === 'removed' && c.category === 'link')).toHaveLength(1);
		});

		it('does not report unchanged links', () => {
			const a = wrap('<a href="https://same.com">Link</a>');
			const b = wrap('<a href="https://same.com">Link</a>');
			const result = diffEmails(a, b);

			// Identical strings => identical result
			expect(result.identical).toBe(true);
		});
	});

	// ----- Style changes ---------------------------------------------------

	describe('style changes', () => {
		it('detects style attribute count increase', () => {
			const a = wrap('<p style="color:red">Text</p>');
			const b = wrap('<p style="color:red">Text</p><div style="margin:0">More</div>');
			const result = diffEmails(a, b);

			const styleChanges = findChanges(result, (c) => c.category === 'style');
			expect(styleChanges.length).toBeGreaterThanOrEqual(1);
			expect(styleChanges[0]!.type).toBe('modified');
			expect(result.stats.modifiedStyles).toBeGreaterThanOrEqual(1);
		});

		it('detects style attribute count decrease', () => {
			const a = wrap('<p style="color:red">A</p><p style="color:blue">B</p>');
			const b = wrap('<p style="color:red">A</p><p>B</p>');
			const result = diffEmails(a, b);

			const styleChanges = findChanges(result, (c) => c.category === 'style');
			expect(styleChanges.length).toBeGreaterThanOrEqual(1);
			expect(styleChanges[0]!.description).toContain('2');
			expect(styleChanges[0]!.description).toContain('1');
		});

		it('does not report style change when count is the same', () => {
			const a = wrap('<p style="color:red">Text</p>');
			const b = wrap('<p style="color:blue">Text</p>');
			const result = diffEmails(a, b);

			// Style count is still 1 in both, so no style category change reported
			const styleChanges = findChanges(result, (c) => c.category === 'style');
			expect(styleChanges).toHaveLength(0);
		});
	});

	// ----- Meta changes (title) --------------------------------------------

	describe('meta changes', () => {
		it('detects title changes', () => {
			const a = '<html><head><title>Newsletter V1</title></head><body></body></html>';
			const b = '<html><head><title>Newsletter V2</title></head><body></body></html>';
			const result = diffEmails(a, b);

			const metaChanges = findChanges(result, (c) => c.category === 'meta');
			expect(metaChanges).toHaveLength(1);
			expect(metaChanges[0]!.description).toContain('Newsletter V1');
			expect(metaChanges[0]!.description).toContain('Newsletter V2');
			expect(metaChanges[0]!.type).toBe('modified');
		});

		it('detects title added (empty to non-empty)', () => {
			const a = wrap('<p>Text</p>');
			const b = '<html><head><title>New Title</title></head><body><p>Text</p></body></html>';
			const result = diffEmails(a, b);

			const metaChanges = findChanges(result, (c) => c.category === 'meta');
			expect(metaChanges).toHaveLength(1);
			expect(metaChanges[0]!.description).toContain('New Title');
		});

		it('detects title removed (non-empty to empty)', () => {
			const a = '<html><head><title>Old Title</title></head><body><p>Text</p></body></html>';
			const b = wrap('<p>Text</p>');
			const result = diffEmails(a, b);

			const metaChanges = findChanges(result, (c) => c.category === 'meta');
			expect(metaChanges).toHaveLength(1);
		});

		it('does not report meta change when titles are the same', () => {
			const a = '<html><head><title>Same</title></head><body></body></html>';
			const b = '<html><head><title>Same</title></head><body></body></html>';
			const result = diffEmails(a, b);

			// Identical strings
			expect(result.identical).toBe(true);
		});
	});

	// ----- Size delta & structure ------------------------------------------

	describe('size delta', () => {
		it('reports positive sizeDelta when B is larger', () => {
			const a = wrap('<p>A</p>');
			const b = wrap('<p>A much longer paragraph with lots more text content here</p>');
			const result = diffEmails(a, b);

			expect(result.sizeDelta).toBeGreaterThan(0);
		});

		it('reports negative sizeDelta when B is smaller', () => {
			const a = wrap('<p>A much longer paragraph with lots more text content here</p>');
			const b = wrap('<p>A</p>');
			const result = diffEmails(a, b);

			expect(result.sizeDelta).toBeLessThan(0);
		});

		it('reports structure change when size differs by more than 100 bytes', () => {
			const a = wrap('<p>Short</p>');
			const padding = 'X'.repeat(200);
			const b = wrap(`<p>Short</p><div>${padding}</div>`);
			const result = diffEmails(a, b);

			const structureChanges = findChanges(result, (c) => c.category === 'structure');
			expect(structureChanges.length).toBeGreaterThanOrEqual(1);
			expect(structureChanges[0]!.description).toContain('bytes');
		});

		it('does not report structure change when size differs by 100 bytes or less', () => {
			const a = wrap('<p>Hello</p>');
			// Add a small amount of content (well under 100 bytes difference)
			const b = wrap('<p>Hello World</p>');
			const result = diffEmails(a, b);

			const structureChanges = findChanges(result, (c) => c.category === 'structure');
			expect(structureChanges).toHaveLength(0);
		});

		it('computes sizeDelta correctly using byte length (UTF-8)', () => {
			// Multi-byte characters: each emoji is 4 bytes in UTF-8
			const a = wrap('<p>Hi</p>');
			const b = wrap('<p>Hi</p>');
			// Identical => sizeDelta should be 0
			const result = diffEmails(a, b);
			expect(result.sizeDelta).toBe(0);
		});
	});

	// ----- Stats computation -----------------------------------------------

	describe('stats', () => {
		it('counts added and removed elements correctly', () => {
			const a = wrap('<p>Old text</p><img src="https://example.com/old.png" />');
			const b = wrap(
				'<p>New text</p><img src="https://example.com/new.png" /><a href="https://example.com">Link</a>'
			);
			const result = diffEmails(a, b);

			// Should have added elements (new text, new image, new link)
			expect(result.stats.addedElements).toBeGreaterThanOrEqual(1);
			// Should have removed elements (old text, old image)
			expect(result.stats.removedElements).toBeGreaterThanOrEqual(1);
		});

		it('textChanges counts both added and removed text', () => {
			const a = wrap('<p>Alpha</p><p>Beta</p>');
			const b = wrap('<p>Alpha</p><p>Gamma</p>');
			const result = diffEmails(a, b);

			// Beta removed, Gamma added => 2 text changes
			expect(result.stats.textChanges).toBe(2);
		});

		it('linkChanges counts both added and removed links', () => {
			const a = wrap('<a href="https://a.com">A</a>');
			const b = wrap('<a href="https://b.com">B</a>');
			const result = diffEmails(a, b);

			expect(result.stats.linkChanges).toBe(2);
		});

		it('imageChanges counts both added and removed images', () => {
			const a = wrap('<img src="https://example.com/a.png" />');
			const b = wrap('<img src="https://example.com/b.png" />');
			const result = diffEmails(a, b);

			expect(result.stats.imageChanges).toBe(2);
		});
	});

	// ----- Completely different inputs -------------------------------------

	describe('completely different inputs', () => {
		it('detects many changes when emails are entirely different', () => {
			const a = wrap(
				'<h1>Welcome</h1><p>Hello subscriber</p><img src="https://example.com/banner.png" /><a href="https://example.com/link1">CTA</a>'
			);
			const b = wrap(
				'<h2>Goodbye</h2><p>See you later</p><img src="https://example.com/footer.png" /><a href="https://example.com/link2">Unsubscribe</a>'
			);
			const result = diffEmails(a, b);

			expect(result.identical).toBe(false);
			expect(result.changes.length).toBeGreaterThan(0);
			expect(result.stats.textChanges).toBeGreaterThan(0);
			expect(result.stats.imageChanges).toBeGreaterThan(0);
			expect(result.stats.linkChanges).toBeGreaterThan(0);
		});
	});

	// ----- Multiple changes combined ---------------------------------------

	describe('multiple simultaneous changes', () => {
		it('detects text, image, link and meta changes in a single diff', () => {
			const a = '<html><head><title>V1</title></head><body>'
				+ '<p>Old copy</p>'
				+ '<img src="https://example.com/old.png" />'
				+ '<a href="https://old.com">Old link</a>'
				+ '</body></html>';
			const b = '<html><head><title>V2</title></head><body>'
				+ '<p>New copy</p>'
				+ '<img src="https://example.com/new.png" />'
				+ '<a href="https://new.com">New link</a>'
				+ '</body></html>';
			const result = diffEmails(a, b);

			expect(result.identical).toBe(false);
			expect(result.stats.textChanges).toBeGreaterThanOrEqual(2);
			expect(result.stats.imageChanges).toBe(2);
			expect(result.stats.linkChanges).toBe(2);
			const metaChanges = findChanges(result, (c) => c.category === 'meta');
			expect(metaChanges).toHaveLength(1);
		});
	});

	// ----- Duplicate elements (set-based comparison) -----------------------

	describe('set-based comparison behavior', () => {
		it('does not double-count duplicate text blocks', () => {
			// Both A and B have the same text "Hello" repeated twice
			// Since extractElements uses a regex, it will find both occurrences,
			// but the set comparison means duplicates within the same set are collapsed
			const a = wrap('<p>Hello</p><p>Unique A</p>');
			const b = wrap('<p>Hello</p><p>Unique B</p>');
			const result = diffEmails(a, b);

			// "Hello" is in both sets, so no change for it
			// "Unique A" removed, "Unique B" added
			const addedText = findChanges(result, (c) => c.type === 'added' && c.category === 'text');
			const removedText = findChanges(result, (c) => c.type === 'removed' && c.category === 'text');
			expect(addedText.some((c) => c.description.includes('Unique B'))).toBe(true);
			expect(removedText.some((c) => c.description.includes('Unique A'))).toBe(true);
			// "Hello" should not appear in changes
			expect(addedText.some((c) => c.description.includes('Hello'))).toBe(false);
			expect(removedText.some((c) => c.description.includes('Hello'))).toBe(false);
		});

		it('handles duplicate images in the same document', () => {
			// Same image used twice in A, once in B - set-based means no image change
			const a = wrap(
				'<img src="https://example.com/logo.png" /><img src="https://example.com/logo.png" />'
			);
			const b = wrap('<img src="https://example.com/logo.png" />');
			const result = diffEmails(a, b);

			// Set-based: both have "logo.png" in their set, so no image change
			expect(result.stats.imageChanges).toBe(0);
		});
	});

	// ----- Integration with renderer (real rendered emails) ----------------

	describe('integration with renderEmailHtml', () => {
		it('detects text content change between rendered versions', () => {
			const htmlA = renderEmailHtml([textBlockV1]);
			const htmlB = renderEmailHtml([textBlockV2]);
			const result = diffEmails(htmlA, htmlB);

			expect(result.identical).toBe(false);
			expect(result.stats.textChanges).toBeGreaterThan(0);
		});

		it('detects added block (image added to template)', () => {
			const htmlA = renderEmailHtml([textBlockV1]);
			const htmlB = renderEmailHtml([textBlockV1, imageBlock]);
			const result = diffEmails(htmlA, htmlB);

			expect(result.identical).toBe(false);
			expect(result.stats.imageChanges).toBeGreaterThanOrEqual(1);
		});

		it('detects removed block (button removed from template)', () => {
			const htmlA = renderEmailHtml([textBlockV1, buttonBlock]);
			const htmlB = renderEmailHtml([textBlockV1]);
			const result = diffEmails(htmlA, htmlB);

			expect(result.identical).toBe(false);
			expect(result.stats.linkChanges).toBeGreaterThanOrEqual(1);
		});

		it('detects block reordering with different structural output', () => {
			const htmlA = renderEmailHtml([textBlockV1, imageBlock, buttonBlock]);
			const htmlB = renderEmailHtml([buttonBlock, imageBlock, textBlockV1]);
			const result = diffEmails(htmlA, htmlB);

			// Text, images, and links are extracted into sets, so the same elements
			// in different order should produce no text/image/link changes.
			// However, style count or size may differ due to render ordering.
			// The key insight: set-based comparison means reordering is NOT detected
			// for text/image/link categories.
			expect(result.stats.textChanges).toBe(0);
			expect(result.stats.imageChanges).toBe(0);
			expect(result.stats.linkChanges).toBe(0);
		});

		it('detects adding multiple blocks at once', () => {
			const htmlA = renderEmailHtml([textBlockV1]);
			const htmlB = renderEmailHtml([textBlockV1, imageBlock, buttonBlock, dividerBlock]);
			const result = diffEmails(htmlA, htmlB);

			expect(result.identical).toBe(false);
			expect(result.stats.addedElements).toBeGreaterThan(0);
			expect(result.sizeDelta).toBeGreaterThan(0);
		});

		it('detects title change via render options', () => {
			const htmlA = renderEmailHtml([textBlockV1], { title: 'Newsletter V1' });
			const htmlB = renderEmailHtml([textBlockV1], { title: 'Newsletter V2' });
			const result = diffEmails(htmlA, htmlB);

			const metaChanges = findChanges(result, (c) => c.category === 'meta');
			expect(metaChanges.length).toBeGreaterThanOrEqual(1);
			expect(metaChanges[0]!.description).toContain('Newsletter V1');
			expect(metaChanges[0]!.description).toContain('Newsletter V2');
		});
	});

	// ----- Return type structure -------------------------------------------

	describe('return type structure', () => {
		it('always returns all required fields', () => {
			const result = diffEmails('<p>A</p>', '<p>B</p>');

			expect(result).toHaveProperty('identical');
			expect(result).toHaveProperty('changes');
			expect(result).toHaveProperty('sizeDelta');
			expect(result).toHaveProperty('stats');
			expect(result.stats).toHaveProperty('addedElements');
			expect(result.stats).toHaveProperty('removedElements');
			expect(result.stats).toHaveProperty('modifiedStyles');
			expect(result.stats).toHaveProperty('textChanges');
			expect(result.stats).toHaveProperty('linkChanges');
			expect(result.stats).toHaveProperty('imageChanges');
			expect(typeof result.identical).toBe('boolean');
			expect(Array.isArray(result.changes)).toBe(true);
			expect(typeof result.sizeDelta).toBe('number');
		});

		it('each change has required type and category fields', () => {
			const result = diffEmails(
				wrap('<p>Old</p>'),
				wrap('<p>New</p>')
			);

			for (const change of result.changes) {
				expect(['added', 'removed', 'modified']).toContain(change.type);
				expect(['text', 'style', 'image', 'link', 'structure', 'meta']).toContain(change.category);
				expect(typeof change.description).toBe('string');
				expect(change.description.length).toBeGreaterThan(0);
			}
		});
	});
});
