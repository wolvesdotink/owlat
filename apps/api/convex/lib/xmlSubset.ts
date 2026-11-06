/**
 * A small XML reader for documents the backend fetches from servers a user
 * named: Thunderbird autoconfig files (`mail/external/autodiscover.ts`) and
 * WebDAV multistatus answers (`mail/contactsCardDavProtocol.ts`).
 *
 * Hand-written because the Node action runtime has no `DOMParser`. It reads
 * elements, attributes, text, comments, CDATA, the five predefined entities and
 * character references, and refuses anything else, a DOCTYPE included, so no
 * document can make it expand an entity or fetch anything. Namespaces are not
 * resolved: callers that read namespaced documents match on
 * {@link localName}.
 */

export type XmlNode = XmlElement | string;

export interface XmlElement {
	/** The qualified name as written, prefix included (`d:href`). */
	name: string;
	attributes: Map<string, string>;
	children: XmlNode[];
}

const NAME = '[A-Za-z_][\\w.:-]*';
const ATTRIBUTE = `${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*')`;
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${ATTRIBUTE})*)\\s*(/?)>`, 'y');
const END_TAG = new RegExp(`</(${NAME})\\s*>`, 'y');
const ATTRIBUTES = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g');
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
// Autoconfig documents nest four deep and WebDAV multistatus answers six; a
// deeper document is neither, and the recursive reads below must not be handed
// one that overflows the stack.
const MAX_DEPTH = 16;
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/** Decode XML entities; `null` for a bare `&` or an unknown entity. */
function decodeEntities(raw: string): string | null {
	if (raw.replace(ENTITY, '').includes('&')) return null;
	return raw.replace(ENTITY, (_, hex: string, dec: string, named: string) => {
		if (named) return NAMED_ENTITIES[named] ?? '';
		return String.fromCodePoint(hex ? parseInt(hex, 16) : parseInt(dec, 10));
	});
}

/**
 * Parse a well-formed document into its root element, or `null`. A character
 * reference outside Unicode is `null` too, not a throw.
 */
export function parseXml(xml: string): XmlElement | null {
	try {
		return parseDocument(xml);
	} catch {
		return null;
	}
}

function parseDocument(xml: string): XmlElement | null {
	const stack: XmlElement[] = [];
	let root: XmlElement | null = null;
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf('<', i);
		const textEnd = lt === -1 ? xml.length : lt;
		if (textEnd > i) {
			const raw = xml.slice(i, textEnd);
			const parent = stack[stack.length - 1];
			if (!parent) {
				if (raw.trim() !== '') return null;
			} else {
				const text = decodeEntities(raw);
				if (text === null) return null;
				parent.children.push(text);
			}
		}
		if (lt === -1) break;

		if (xml.startsWith('<?', lt)) {
			const end = xml.indexOf('?>', lt + 2);
			if (end === -1) return null;
			i = end + 2;
			continue;
		}
		if (xml.startsWith('<!--', lt)) {
			const end = xml.indexOf('-->', lt + 4);
			if (end === -1) return null;
			i = end + 3;
			continue;
		}
		if (xml.startsWith('<![CDATA[', lt)) {
			const parent = stack[stack.length - 1];
			const end = xml.indexOf(']]>', lt + 9);
			if (!parent || end === -1) return null;
			parent.children.push(xml.slice(lt + 9, end));
			i = end + 3;
			continue;
		}
		// A DOCTYPE or any other declaration: the format needs none.
		if (xml.startsWith('<!', lt)) return null;

		END_TAG.lastIndex = lt;
		const close = END_TAG.exec(xml);
		if (close) {
			const open = stack.pop();
			if (!open || open.name !== close[1]) return null;
			i = END_TAG.lastIndex;
			continue;
		}

		START_TAG.lastIndex = lt;
		const tag = START_TAG.exec(xml);
		if (!tag) return null;
		const attributes = new Map<string, string>();
		for (const attr of (tag[2] ?? '').matchAll(ATTRIBUTES)) {
			const value = decodeEntities(attr[2] ?? attr[3] ?? '');
			if (value === null || attributes.has(attr[1]!)) return null;
			attributes.set(attr[1]!, value);
		}
		const element: XmlElement = { name: tag[1]!, attributes, children: [] };
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(element);
		else if (root) return null;
		else root = element;
		if (tag[3] !== '/') {
			if (stack.length >= MAX_DEPTH) return null;
			stack.push(element);
		}
		i = START_TAG.lastIndex;
	}
	return stack.length === 0 ? root : null;
}

/** Every element named `name` at or below `root`, in document order. */
export function descendants(root: XmlElement, name: string): XmlElement[] {
	const found: XmlElement[] = [];
	const visit = (el: XmlElement) => {
		if (el.name === name) found.push(el);
		for (const child of el.children) if (typeof child !== 'string') visit(child);
	};
	visit(root);
	return found;
}

/** The concatenated text below `el`. */
export function textContent(el: XmlElement): string {
	return el.children
		.map((child) => (typeof child === 'string' ? child : textContent(child)))
		.join('');
}

/** The element name without its namespace prefix (`d:href` → `href`). */
export function localName(el: XmlElement): string {
	const colon = el.name.indexOf(':');
	return colon >= 0 ? el.name.slice(colon + 1) : el.name;
}

/** The element children of `el` whose local name is `name`. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
	return el.children.filter(
		(child): child is XmlElement => typeof child !== 'string' && localName(child) === name
	);
}

/** Every element at or below `root` whose local name is `name`, in document order. */
export function descendantsNamed(root: XmlElement, name: string): XmlElement[] {
	const found: XmlElement[] = [];
	const visit = (el: XmlElement) => {
		if (localName(el) === name) found.push(el);
		for (const child of el.children) if (typeof child !== 'string') visit(child);
	};
	visit(root);
	return found;
}
