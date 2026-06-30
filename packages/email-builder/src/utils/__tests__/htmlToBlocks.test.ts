/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { htmlToBlocks } from '../htmlToBlocks';
import type { TextBlockContent, ImageBlockContent, EditorBlock } from '../../types';

/** Helper: collect types from resulting blocks */
function blockTypes(blocks: EditorBlock[]) {
	return blocks.map((b) => b.type);
}

describe('htmlToBlocks', () => {
	// ── Plain text ──────────────────────────────────────────────────────────

	it('converts plain text to a single text block', () => {
		const blocks = htmlToBlocks('Hello world');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
		expect((blocks[0].content as TextBlockContent).html).toBe('Hello world');
		expect((blocks[0].content as TextBlockContent).blockType).toBe('paragraph');
	});

	it('returns empty array for whitespace-only input', () => {
		expect(htmlToBlocks('   ')).toHaveLength(0);
		expect(htmlToBlocks('')).toHaveLength(0);
	});

	// ── Paragraphs with inline formatting ───────────────────────────────────

	it('preserves bold and italic in a paragraph', () => {
		const blocks = htmlToBlocks('<p>Hello <b>bold</b> and <i>italic</i></p>');
		expect(blocks).toHaveLength(1);
		const html = (blocks[0].content as TextBlockContent).html;
		expect(html).toContain('<b>bold</b>');
		expect(html).toContain('<i>italic</i>');
	});

	it('preserves links in a paragraph', () => {
		const blocks = htmlToBlocks('<p>Visit <a href="https://example.com">here</a></p>');
		expect(blocks).toHaveLength(1);
		const html = (blocks[0].content as TextBlockContent).html;
		expect(html).toContain('<a href="https://example.com">here</a>');
	});

	it('preserves underline and strikethrough', () => {
		const blocks = htmlToBlocks('<p><u>underline</u> and <s>strike</s></p>');
		expect(blocks).toHaveLength(1);
		const html = (blocks[0].content as TextBlockContent).html;
		expect(html).toContain('<u>underline</u>');
		expect(html).toContain('<s>strike</s>');
	});

	// ── Headings ────────────────────────────────────────────────────────────

	it('converts h1 to text block with blockType h1', () => {
		const blocks = htmlToBlocks('<h1>Title</h1>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
		const content = blocks[0].content as TextBlockContent;
		expect(content.blockType).toBe('h1');
		expect(content.fontSize).toBe(32);
		expect(content.html).toBe('Title');
	});

	it('converts h2 to text block with blockType h2', () => {
		const blocks = htmlToBlocks('<h2>Subtitle</h2>');
		const content = blocks[0].content as TextBlockContent;
		expect(content.blockType).toBe('h2');
		expect(content.fontSize).toBe(24);
	});

	it('converts h3 to text block with blockType h3', () => {
		const blocks = htmlToBlocks('<h3>Section</h3>');
		const content = blocks[0].content as TextBlockContent;
		expect(content.blockType).toBe('h3');
		expect(content.fontSize).toBe(20);
	});

	// ── Images ──────────────────────────────────────────────────────────────

	it('converts img to image block with src and alt', () => {
		const blocks = htmlToBlocks('<img src="https://example.com/img.png" alt="Photo">');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('image');
		const content = blocks[0].content as ImageBlockContent;
		expect(content.src).toBe('https://example.com/img.png');
		expect(content.alt).toBe('Photo');
	});

	it('skips img without src', () => {
		const blocks = htmlToBlocks('<img alt="no source">');
		expect(blocks).toHaveLength(0);
	});

	// ── Divider ─────────────────────────────────────────────────────────────

	it('converts hr to divider block', () => {
		const blocks = htmlToBlocks('<hr>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('divider');
	});

	// ── Lists ───────────────────────────────────────────────────────────────

	it('converts unordered list items to text blocks with bullet prefix', () => {
		const blocks = htmlToBlocks('<ul><li>Item A</li><li>Item B</li></ul>');
		expect(blocks).toHaveLength(2);
		// &bull; is decoded to • by the DOM
		expect((blocks[0].content as TextBlockContent).html).toContain('Item A');
		expect((blocks[0].content as TextBlockContent).html).toMatch(/[•\u2022]|&bull;/);
		expect((blocks[1].content as TextBlockContent).html).toContain('Item B');
	});

	it('converts ordered list items to text blocks with number prefix', () => {
		const blocks = htmlToBlocks('<ol><li>First</li><li>Second</li></ol>');
		expect(blocks).toHaveLength(2);
		expect((blocks[0].content as TextBlockContent).html).toContain('1. First');
		expect((blocks[1].content as TextBlockContent).html).toContain('2. Second');
	});

	it('keeps ordered-list numbering aligned across an empty item', () => {
		// An empty <li> still consumes an ordinal (browser behavior), so the
		// item after it must be numbered 3, not 2.
		const blocks = htmlToBlocks('<ol><li>First</li><li></li><li>Third</li></ol>');
		expect(blocks).toHaveLength(2);
		expect((blocks[0].content as TextBlockContent).html).toContain('1. First');
		expect((blocks[1].content as TextBlockContent).html).toContain('3. Third');
	});

	// ── Mixed content ───────────────────────────────────────────────────────

	it('handles mixed heading + paragraph + image', () => {
		const html = `
			<h1>Welcome</h1>
			<p>Some text here</p>
			<img src="https://example.com/photo.jpg" alt="A photo">
		`;
		const blocks = htmlToBlocks(html);
		expect(blockTypes(blocks)).toEqual(['text', 'text', 'image']);
		expect((blocks[0].content as TextBlockContent).blockType).toBe('h1');
		expect((blocks[1].content as TextBlockContent).blockType).toBe('paragraph');
	});

	it('handles heading + list + divider', () => {
		const html = `
			<h2>Features</h2>
			<ul><li>Fast</li><li>Simple</li></ul>
			<hr>
			<p>Footer text</p>
		`;
		const blocks = htmlToBlocks(html);
		expect(blockTypes(blocks)).toEqual(['text', 'text', 'text', 'divider', 'text']);
	});

	// ── Google Docs ─────────────────────────────────────────────────────────

	it('strips Google Docs internal wrapper', () => {
		const html = `
			<b id="docs-internal-guid-abc123">
				<p>Google Docs paragraph</p>
			</b>
		`;
		const blocks = htmlToBlocks(html);
		expect(blocks).toHaveLength(1);
		expect((blocks[0].content as TextBlockContent).html).toContain('Google Docs paragraph');
	});

	// ── Notion ──────────────────────────────────────────────────────────────

	it('strips Notion data-block-id wrappers', () => {
		const html = `
			<div data-block-id="abc-123">
				<p>Notion paragraph</p>
			</div>
		`;
		const blocks = htmlToBlocks(html);
		expect(blocks).toHaveLength(1);
		expect((blocks[0].content as TextBlockContent).html).toContain('Notion paragraph');
	});

	// ── Nested divs ─────────────────────────────────────────────────────────

	it('unwraps nested divs to extract content', () => {
		const html = `
			<div><div><div><p>Deeply nested</p></div></div></div>
		`;
		const blocks = htmlToBlocks(html);
		expect(blocks).toHaveLength(1);
		expect((blocks[0].content as TextBlockContent).html).toContain('Deeply nested');
	});

	// ── Block IDs ───────────────────────────────────────────────────────────

	it('generates unique block IDs with block- prefix', () => {
		const blocks = htmlToBlocks('<p>A</p><p>B</p>');
		expect(blocks).toHaveLength(2);
		expect(blocks[0].id).toMatch(/^block-/);
		expect(blocks[1].id).toMatch(/^block-/);
		expect(blocks[0].id).not.toBe(blocks[1].id);
	});

	// ── Tables ──────────────────────────────────────────────────────────────

	it('extracts text from table cells as text blocks', () => {
		const html = `
			<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>
		`;
		const blocks = htmlToBlocks(html);
		expect(blocks).toHaveLength(2);
		expect(blocks.every((b) => b.type === 'text')).toBe(true);
	});

	// ── Sanitization ────────────────────────────────────────────────────────

	it('strips disallowed tags but keeps content', () => {
		const blocks = htmlToBlocks('<p>Hello <script>alert("xss")</script> world</p>');
		expect(blocks).toHaveLength(1);
		const html = (blocks[0].content as TextBlockContent).html;
		expect(html).not.toContain('<script>');
		expect(html).toContain('world');
	});
});
