/**
 * Pin something found in the rendered HTML (a link, an image) back to the
 * Block that produced it, so "Show me" can select it in the builder.
 *
 * The renderer writes no Block ids into the HTML, so this matches on content:
 * the deepest Block whose own content holds the URL wins. A URL the HTML-escaped
 * text of a text Block carries (`&amp;`) is matched in that form too. The URL
 * must be a whole value there (a property's string, or a quoted attribute in a
 * Block's HTML), so `#` does not match a colour like `#374151`, nor
 * `https://example.com` a Block linking to `https://example.com/page`. Nothing
 * found means no "Show me" for that item, never a wrong one.
 */
import type { EditorBlock } from '@owlat/shared';
import { childBlockLists, type BlockTreeNode } from '@owlat/shared/blockTree';

/** The content of `node` without its child Blocks, as searchable text. */
function ownContent(node: BlockTreeNode): string {
	const children = new Set(childBlockLists(node).flat());
	return JSON.stringify(node.content, (_key, value: unknown) =>
		children.has(value as BlockTreeNode) ? undefined : value
	);
}

function variants(needle: string): string[] {
	const escaped = needle.replace(/&/g, '&amp;');
	// JSON escapes quotes and backslashes; match the stored form.
	return [...new Set([needle, escaped])].map((value) => JSON.stringify(value).slice(1, -1));
}

/**
 * Whether `form` sits in `own` as a whole value: opened by a quote (a JSON
 * string, or an attribute in a Block's HTML, `href=\"…\"` once serialized)
 * and closed by one (`"`, the `\` of an escaped `\"`, or `'`).
 */
function holdsValue(own: string, form: string): boolean {
	for (let at = own.indexOf(form); at !== -1; at = own.indexOf(form, at + 1)) {
		const before = own[at - 1];
		const after = own[at + form.length];
		if ((before === '"' || before === "'") && (after === '"' || after === '\\' || after === "'")) {
			return true;
		}
	}
	return false;
}

function search(nodes: readonly BlockTreeNode[], forms: string[]): string | undefined {
	for (const node of nodes) {
		const deeper = search(childBlockLists(node).flat(), forms);
		if (deeper) return deeper;
		const own = ownContent(node);
		if (forms.some((form) => holdsValue(own, form))) return node.id;
	}
	return undefined;
}

/** The id of the deepest Block whose content contains `needle`. */
export function findBlockIdContaining(
	blocks: readonly BlockTreeNode[],
	needle: string
): string | undefined {
	if (!needle) return undefined;
	return search(blocks, variants(needle));
}

/**
 * The Blocks of an email template's stored `content`, for the Review step,
 * which has the stored row rather than a live canvas. Email templates store a
 * bare array (`@owlat/email-builder`'s `parseStoredBlocks` reads every stored
 * shape, but pulling the builder into the wizard for it is not worth its
 * weight). A Block without an id is dropped: the editor would give it a fresh
 * one, so nothing here could point at it.
 */
export function readStoredBlocks(content: string | null | undefined): EditorBlock[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content || '[]');
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(entry): entry is EditorBlock =>
			typeof entry === 'object' &&
			entry !== null &&
			typeof (entry as { id?: unknown }).id === 'string' &&
			typeof (entry as { type?: unknown }).type === 'string' &&
			typeof (entry as { content?: unknown }).content === 'object'
	);
}
