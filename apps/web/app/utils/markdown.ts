/**
 * A small, dependency-free Markdown parser for AI assistant output.
 *
 * Produces a typed block/inline AST that `AssistantMarkdown.vue` renders through
 * Vue's template system (text is interpolated, never `v-html`), so there is no
 * XSS surface — assistant/tool output is untrusted and must never inject markup.
 * Covers the constructs assistants actually emit: headings, paragraphs, fenced +
 * inline code, bold/italic, links, blockquotes, ordered/unordered lists, and
 * horizontal rules. Not a full CommonMark implementation (no nested lists,
 * tables, or reference links) — those degrade gracefully to text.
 */

export type Inline =
	| { type: 'text'; value: string }
	| { type: 'strong'; value: string }
	| { type: 'em'; value: string }
	| { type: 'code'; value: string }
	| { type: 'link'; value: string; href: string };

export type Block =
	| { type: 'heading'; level: number; inlines: Inline[] }
	| { type: 'paragraph'; inlines: Inline[] }
	| { type: 'code'; lang: string | null; value: string }
	| { type: 'list'; ordered: boolean; items: Inline[][] }
	| { type: 'blockquote'; inlines: Inline[] }
	| { type: 'hr' };

/** Only http(s) and mailto links are rendered as anchors; anything else stays text. */
export function isSafeHref(href: string): boolean {
	return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const FENCE = /^```(.*)$/;

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Parse inline spans (code, bold, italic, links) within a line of text. */
export function parseInlines(text: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	INLINE.lastIndex = 0;
	while ((m = INLINE.exec(text)) !== null) {
		if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
		const tok = m[0];
		if (m[1]) {
			out.push({ type: 'code', value: tok.slice(1, -1) });
		} else if (m[2]) {
			out.push({ type: 'strong', value: tok.slice(2, -2) });
		} else if (m[3]) {
			out.push({ type: 'em', value: tok.slice(1, -1) });
		} else if (m[4]) {
			const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
			if (lm && lm[1] !== undefined && lm[2] !== undefined && isSafeHref(lm[2])) {
				out.push({ type: 'link', value: lm[1], href: lm[2] });
			} else {
				out.push({ type: 'text', value: tok });
			}
		}
		last = m.index + tok.length;
	}
	if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
	return out;
}

/** Parse a Markdown document into a block AST. */
export function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? '';
		const trimmed = line.trim();

		// Blank line — skip.
		if (trimmed === '') {
			i++;
			continue;
		}

		// Fenced code block.
		const fence = FENCE.exec(trimmed);
		if (fence) {
			const lang = fence[1]?.trim() || null;
			const body: string[] = [];
			i++;
			while (i < lines.length && !FENCE.test((lines[i] ?? '').trim())) {
				body.push(lines[i] ?? '');
				i++;
			}
			i++; // consume the closing fence (if present)
			blocks.push({ type: 'code', lang, value: body.join('\n') });
			continue;
		}

		// Horizontal rule.
		if (HR.test(line)) {
			blocks.push({ type: 'hr' });
			i++;
			continue;
		}

		// Heading.
		const heading = HEADING.exec(line);
		if (heading && heading[1] && heading[2] !== undefined) {
			blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInlines(heading[2]) });
			i++;
			continue;
		}

		// Blockquote (consecutive `>` lines).
		if (BLOCKQUOTE.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && BLOCKQUOTE.test(lines[i] ?? '')) {
				quoted.push(BLOCKQUOTE.exec(lines[i] ?? '')?.[1] ?? '');
				i++;
			}
			blocks.push({ type: 'blockquote', inlines: parseInlines(quoted.join(' ')) });
			continue;
		}

		// List (consecutive list-item lines).
		if (LIST_ITEM.test(line)) {
			const first = LIST_ITEM.exec(line);
			const ordered = /\d+\./.test(first?.[1] ?? '');
			const items: Inline[][] = [];
			while (i < lines.length && LIST_ITEM.test(lines[i] ?? '')) {
				const item = LIST_ITEM.exec(lines[i] ?? '');
				items.push(parseInlines(item?.[2] ?? ''));
				i++;
			}
			blocks.push({ type: 'list', ordered, items });
			continue;
		}

		// Paragraph (consecutive plain lines until a blank line or a new block).
		const para: string[] = [];
		while (i < lines.length) {
			const l = lines[i] ?? '';
			if (l.trim() === '') break;
			if (HEADING.test(l) || HR.test(l) || BLOCKQUOTE.test(l) || LIST_ITEM.test(l) || FENCE.test(l.trim())) break;
			para.push(l.trim());
			i++;
		}
		blocks.push({ type: 'paragraph', inlines: parseInlines(para.join(' ')) });
	}

	return blocks;
}
