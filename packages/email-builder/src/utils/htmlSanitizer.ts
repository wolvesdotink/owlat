/**
 * Sanitize HTML from contenteditable output.
 *
 * Whitelists safe tags for email text content and strips everything else.
 * This is a lightweight sanitizer for the RichTextEditor panel — the final
 * email HTML is produced by the renderer, not this editor.
 */

const ALLOWED_TAGS = new Set([
	'p',
	'br',
	'strong',
	'b',
	'em',
	'i',
	'u',
	'a',
	's',
	'strike',
	'span',
	'div',
	'h1',
	'h2',
	'h3',
	'ul',
	'ol',
	'li',
]);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(['href', 'target', 'rel']),
	span: new Set(['class', 'data-variable', 'contenteditable', 'style']),
	div: new Set(['class']),
};

/**
 * Sanitize HTML string, keeping only whitelisted tags and attributes.
 * Uses the browser's DOMParser for reliable parsing.
 */
export function sanitizeHtml(html: string): string {
	if (typeof DOMParser === 'undefined') return html;

	const doc = new DOMParser().parseFromString(html, 'text/html');
	sanitizeNode(doc.body);
	return doc.body.innerHTML;
}

function sanitizeNode(node: Node): void {
	const children = Array.from(node.childNodes);
	for (const child of children) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			const tagName = el.tagName.toLowerCase();

			if (!ALLOWED_TAGS.has(tagName)) {
				// Replace disallowed element with its children
				while (el.firstChild) {
					node.insertBefore(el.firstChild, el);
				}
				node.removeChild(el);
			} else {
				// Strip disallowed attributes
				const allowed = ALLOWED_ATTRIBUTES[tagName];
				const attrs = Array.from(el.attributes);
				for (const attr of attrs) {
					if (!allowed?.has(attr.name)) {
						el.removeAttribute(attr.name);
					}
				}
				sanitizeNode(el);
			}
		}
	}
}
