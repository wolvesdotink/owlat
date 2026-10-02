/**
 * A deliberately small XML reader for DMARC aggregate reports.
 *
 * DMARC reports (RFC 7489 Appendix C) are plain element trees: no attributes
 * that matter, no mixed content, no entities beyond the five predefined ones.
 * So instead of a general XML parser this reads exactly that subset, and
 * refuses everything that makes XML dangerous to parse:
 *
 * - Any `<!DOCTYPE` or `<!ENTITY` is rejected outright, so there is no DTD,
 *   no external entity (XXE) and no entity expansion ("billion laughs").
 * - Only `&lt; &gt; &amp; &quot; &apos;` and numeric character references are
 *   decoded; any other `&name;` stays literal text.
 * - Element count and nesting depth are capped, and the scan is a single
 *   forward pass with `indexOf`, linear in the input.
 *
 * Never throws: a malformed document comes back as `{ ok: false, error }`.
 */

/** One element: its local name (namespace prefix dropped), children and text. */
export interface XmlElement {
	name: string;
	children: XmlElement[];
	text: string;
}

export type XmlParseResult = { ok: true; root: XmlElement } | { ok: false; error: string };

export interface XmlLimits {
	maxElements: number;
	maxDepth: number;
}

const NAMED_ENTITIES: Record<string, string> = {
	lt: '<',
	gt: '>',
	amp: '&',
	quot: '"',
	apos: "'",
};

/** Decode the predefined entities and numeric references; leave anything else as is. */
function decodeText(raw: string): string {
	if (raw.indexOf('&') < 0) return raw;
	return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (match, body: string) => {
		if (body.startsWith('#')) {
			const code =
				body[1] === 'x' || body[1] === 'X'
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
			return String.fromCodePoint(code);
		}
		return NAMED_ENTITIES[body] ?? match;
	});
}

/** The local name of a start/end tag body (`ns:feedback attr="x"` → `feedback`). */
function tagName(body: string): string {
	let end = 0;
	while (end < body.length && !/[\s/>]/.test(body[end] ?? '')) end++;
	const qualified = body.slice(0, end);
	const colon = qualified.indexOf(':');
	return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

/**
 * Parse `xml` into an element tree. The document must have exactly one root
 * element; text outside it, processing instructions and comments are ignored.
 */
export function parseDmarcXml(xml: string, limits: XmlLimits): XmlParseResult {
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
		return { ok: false, error: 'document type declarations are not allowed' };
	}
	const stack: XmlElement[] = [];
	let root: XmlElement | null = null;
	let elementCount = 0;
	let cursor = 0;

	while (cursor < xml.length) {
		const open = xml.indexOf('<', cursor);
		const textEnd = open < 0 ? xml.length : open;
		if (textEnd > cursor) {
			const current = stack[stack.length - 1];
			if (current) current.text += decodeText(xml.slice(cursor, textEnd));
		}
		if (open < 0) break;

		if (xml.startsWith('<!--', open)) {
			const close = xml.indexOf('-->', open + 4);
			if (close < 0) return { ok: false, error: 'unterminated comment' };
			cursor = close + 3;
			continue;
		}
		if (xml.startsWith('<![CDATA[', open)) {
			const close = xml.indexOf(']]>', open + 9);
			if (close < 0) return { ok: false, error: 'unterminated CDATA section' };
			const current = stack[stack.length - 1];
			if (current) current.text += xml.slice(open + 9, close);
			cursor = close + 3;
			continue;
		}
		if (xml.startsWith('<?', open)) {
			const close = xml.indexOf('?>', open + 2);
			if (close < 0) return { ok: false, error: 'unterminated processing instruction' };
			cursor = close + 2;
			continue;
		}
		if (xml.startsWith('<!', open)) {
			return { ok: false, error: 'unsupported markup declaration' };
		}

		const close = xml.indexOf('>', open + 1);
		if (close < 0) return { ok: false, error: 'unterminated tag' };
		const body = xml.slice(open + 1, close);
		cursor = close + 1;

		if (body.startsWith('/')) {
			const name = tagName(body.slice(1));
			const current = stack.pop();
			if (!current || current.name !== name) {
				return { ok: false, error: `mismatched closing tag </${name}>` };
			}
			if (stack.length === 0) root = current;
			continue;
		}

		const name = tagName(body);
		if (!name) return { ok: false, error: 'empty tag name' };
		if (stack.length === 0 && root) return { ok: false, error: 'more than one root element' };
		elementCount++;
		if (elementCount > limits.maxElements) return { ok: false, error: 'too many elements' };
		const element: XmlElement = { name, children: [], text: '' };
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(element);
		if (body.endsWith('/')) {
			if (!parent) root = element;
			continue;
		}
		stack.push(element);
		if (stack.length > limits.maxDepth) return { ok: false, error: 'nesting too deep' };
	}

	if (stack.length > 0) return { ok: false, error: 'unclosed element' };
	if (!root) return { ok: false, error: 'no root element' };
	return { ok: true, root };
}

/** First direct child with this name, or undefined. */
export function xmlChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
	return element?.children.find((child) => child.name === name);
}

/** Every direct child with this name. */
export function xmlChildren(element: XmlElement | undefined, name: string): XmlElement[] {
	return element ? element.children.filter((child) => child.name === name) : [];
}

/** Trimmed text of the first direct child with this name, or '' when absent. */
export function xmlText(element: XmlElement | undefined, name: string): string {
	return xmlChild(element, name)?.text.trim() ?? '';
}
