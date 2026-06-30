import type { EditorBlock, EmailTheme, TextBlockContent, ImageBlockContent } from '../types';
import { escapeHtml } from '@owlat/shared/html';
import { createDefaultContent } from './blocks';
import { generateId } from './id';
import { sanitizeHtml } from './htmlSanitizer';

/**
 * Convert pasted HTML (from Notion, Google Docs, etc.) into EditorBlock[].
 *
 * Uses DOMParser to walk the clipboard DOM and map elements to block types.
 * Inline formatting (<b>, <i>, <u>, <a>, <s>) is preserved inside text blocks.
 * Unknown/wrapper elements are unwrapped so their children are still processed.
 */
export function htmlToBlocks(html: string, theme?: EmailTheme): EditorBlock[] {
	if (typeof DOMParser === 'undefined') return [];

	const doc = new DOMParser().parseFromString(html, 'text/html');
	const blocks: EditorBlock[] = [];

	processChildren(doc.body, blocks, theme);

	return blocks;
}

// ── Internal ────────────────────────────────────────────────────────────────

/** Tags that represent inline formatting (kept inside text block HTML) */
const INLINE_TAGS = new Set([
	'b', 'strong', 'i', 'em', 'u', 'a', 's', 'strike', 'span', 'sub', 'sup', 'code',
]);

/** Wrapper elements from external apps that should be stripped */
const WRAPPER_SELECTORS = [
	'google-sheets-html-origin',
	'[data-block-id]', // Notion
	'b[id^="docs-internal-guid"]', // Google Docs
];

/** Heading tag → blockType + default fontSize */
const HEADING_MAP: Record<string, { blockType: 'h1' | 'h2' | 'h3'; fontSize: number }> = {
	h1: { blockType: 'h1', fontSize: 32 },
	h2: { blockType: 'h2', fontSize: 24 },
	h3: { blockType: 'h3', fontSize: 20 },
};

function processChildren(parent: Node, blocks: EditorBlock[], theme?: EmailTheme): void {
	for (const child of Array.from(parent.childNodes)) {
		processNode(child, blocks, theme);
	}
}

function processNode(node: Node, blocks: EditorBlock[], theme?: EmailTheme): void {
	// Text node → create text block if non-empty
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent?.trim();
		if (text) {
			blocks.push(makeTextBlock(escapeHtml(text), 'paragraph', theme));
		}
		return;
	}

	if (node.nodeType !== Node.ELEMENT_NODE) return;

	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	// Strip known wrapper elements — unwrap their children
	if (isWrapperElement(el)) {
		processChildren(el, blocks, theme);
		return;
	}

	// <hr> → divider
	if (tag === 'hr') {
		blocks.push(makeDividerBlock(theme));
		return;
	}

	// <img> → image block
	if (tag === 'img') {
		const src = el.getAttribute('src');
		if (src) {
			blocks.push(makeImageBlock(src, el.getAttribute('alt') || '', theme));
		}
		return;
	}

	// Headings
	if (tag in HEADING_MAP) {
		const innerHtml = extractInlineHtml(el);
		if (innerHtml.trim()) {
			const { blockType, fontSize } = HEADING_MAP[tag]!;
			blocks.push(makeTextBlock(sanitizeHtml(innerHtml), blockType, theme, fontSize));
		}
		return;
	}

	// Paragraphs and divs with inline-only content
	if (tag === 'p' || (tag === 'div' && isInlineOnly(el))) {
		const innerHtml = extractInlineHtml(el);
		if (innerHtml.trim()) {
			blocks.push(makeTextBlock(sanitizeHtml(innerHtml), 'paragraph', theme));
		}
		return;
	}

	// Lists → one text block per <li>
	if (tag === 'ul' || tag === 'ol') {
		const items = el.querySelectorAll(':scope > li');
		let index = 0;
		for (const li of Array.from(items)) {
			// Advance the ordinal for every <li>, matching how browsers number
			// ordered lists (an empty item still consumes a number). Empty items
			// are then skipped from output, but later items keep the right index.
			index++;
			const innerHtml = extractInlineHtml(li);
			if (innerHtml.trim()) {
				const prefix = tag === 'ol' ? `${index}. ` : '&bull; ';
				blocks.push(makeTextBlock(sanitizeHtml(prefix + innerHtml), 'paragraph', theme));
			}
		}
		return;
	}

	// <br> as standalone block-level break → spacer
	if (tag === 'br') {
		// Only add spacer if it's a "loose" <br> (not inside a paragraph)
		blocks.push(makeSpacerBlock(theme));
		return;
	}

	// Tables → skip structure, extract text from cells
	if (tag === 'table') {
		const cells = el.querySelectorAll('td, th');
		for (const cell of Array.from(cells)) {
			const text = cell.textContent?.trim();
			if (text) {
				blocks.push(makeTextBlock(sanitizeHtml(escapeHtml(text)), 'paragraph', theme));
			}
		}
		return;
	}

	// Generic block-level elements (div, section, article, etc.) → unwrap
	processChildren(el, blocks, theme);
}

/** Check if an element matches known app-specific wrappers */
function isWrapperElement(el: Element): boolean {
	for (const sel of WRAPPER_SELECTORS) {
		try {
			if (el.matches(sel)) return true;
		} catch {
			// Invalid selector for this tag (e.g. custom element name)
			if (el.tagName.toLowerCase() === sel) return true;
		}
	}
	return false;
}

/** Check if an element only contains inline children (no block-level) */
function isInlineOnly(el: Element): boolean {
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			const childTag = (child as Element).tagName.toLowerCase();
			if (!INLINE_TAGS.has(childTag) && childTag !== 'br' && childTag !== 'img') {
				return false;
			}
		}
	}
	return true;
}

/** Get innerHTML (inline content) of an element */
function extractInlineHtml(el: Element): string {
	return el.innerHTML;
}

// ── Block factories ─────────────────────────────────────────────────────────

function makeTextBlock(
	html: string,
	blockType: 'paragraph' | 'h1' | 'h2' | 'h3',
	theme?: EmailTheme,
	fontSize?: number,
): EditorBlock {
	const content = createDefaultContent('text', theme) as TextBlockContent;
	content.html = html;
	content.blockType = blockType;
	if (fontSize !== undefined) content.fontSize = fontSize;
	return { id: generateId('block'), type: 'text', content };
}

function makeImageBlock(src: string, alt: string, theme?: EmailTheme): EditorBlock {
	const content = createDefaultContent('image', theme) as ImageBlockContent;
	content.src = src;
	content.alt = alt;
	return { id: generateId('block'), type: 'image', content };
}

function makeDividerBlock(theme?: EmailTheme): EditorBlock {
	return { id: generateId('block'), type: 'divider', content: createDefaultContent('divider', theme) } as EditorBlock;
}

function makeSpacerBlock(theme?: EmailTheme): EditorBlock {
	return { id: generateId('block'), type: 'spacer', content: createDefaultContent('spacer', theme) } as EditorBlock;
}
