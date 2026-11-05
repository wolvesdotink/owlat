/**
 * Mail-server autodiscovery, the pure half: which domain an address names, where
 * its autoconfig document lives, and what the document says.
 *
 * The network half is `autodiscoverActions.ts`. The lookups run on the backend
 * because the web app's CSP lets the browser reach no third-party endpoint. The
 * parser is hand-written because the Node action runtime has no `DOMParser`;
 * it reads only the Thunderbird autoconfig subset (elements, attributes, text,
 * comments, CDATA, the five predefined entities and character references) and
 * refuses anything else, a DOCTYPE included, so no document can make it expand
 * an entity or fetch anything.
 */

/** The six IMAP/SMTP fields of the connect form that a lookup can fill. */
export interface DiscoveredMailServers {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
}

/** A plausible dotted hostname; anything else is not worth a lookup. */
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * The lower-cased domain of an email address, or `null` when the address has
 * none worth a DNS query or a fetch.
 */
export function mailDomainOf(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at <= 0) return null;
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase();
	if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return null;
	return domain;
}

/** The Thunderbird ISP database entry for a domain. */
export function ispdbUrl(domain: string): string {
	return `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;
}

/** The autoconfig document a domain may publish for itself. */
export function domainAutoconfigUrl(domain: string, email: string): string {
	return `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`;
}

type XmlNode = XmlElement | string;

interface XmlElement {
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
// An autoconfig document nests four deep; a deeper one is not one, and the
// recursive reads below must not be handed a document that overflows the stack.
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

/** Parse a well-formed document into its root element, or `null`. */
function parseXml(xml: string): XmlElement | null {
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
function descendants(root: XmlElement, name: string): XmlElement[] {
	const found: XmlElement[] = [];
	const visit = (el: XmlElement) => {
		if (el.name === name) found.push(el);
		for (const child of el.children) if (typeof child !== 'string') visit(child);
	};
	visit(root);
	return found;
}

function textContent(el: XmlElement): string {
	return el.children
		.map((child) => (typeof child === 'string' ? child : textContent(child)))
		.join('');
}

/** The trimmed text of the first `tag` below `parent`, or `null`. */
function childText(parent: XmlElement, tag: string): string | null {
	const [first] = descendants(parent, tag);
	return first ? textContent(first).trim() : null;
}

function serverOfType(root: XmlElement, element: string, type: string): XmlElement | undefined {
	return descendants(root, element).find((el) => el.attributes.get('type')?.toLowerCase() === type);
}

const HOSTNAME = /^[a-z0-9.-]+$/i;

function hostOf(server: XmlElement): string | null {
	const host = childText(server, 'hostname');
	return host && host.length <= 253 && HOSTNAME.test(host) ? host : null;
}

function portOf(server: XmlElement): number | null {
	const raw = childText(server, 'port');
	if (!raw || !/^\d{1,5}$/.test(raw)) return null;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : null;
}

/** `socketType` SSL is implicit TLS; STARTTLS and plain are not. */
function isImplicitTls(server: XmlElement): boolean {
	return childText(server, 'socketType')?.toUpperCase() === 'SSL';
}

/**
 * Read the first `<incomingServer type="imap">` and `<outgoingServer type="smtp">`
 * of a Thunderbird autoconfig document. `null` when the document is not
 * well-formed or either server lacks a usable hostname or port.
 */
export function parseAutoconfigXml(xml: string): DiscoveredMailServers | null {
	let root: XmlElement | null;
	try {
		root = parseXml(xml);
	} catch {
		// A character reference outside Unicode makes `fromCodePoint` throw.
		return null;
	}
	if (!root) return null;
	const incoming = serverOfType(root, 'incomingServer', 'imap');
	const outgoing = serverOfType(root, 'outgoingServer', 'smtp');
	if (!incoming || !outgoing) return null;

	const imapHost = hostOf(incoming);
	const imapPort = portOf(incoming);
	const smtpHost = hostOf(outgoing);
	const smtpPort = portOf(outgoing);
	if (!imapHost || !imapPort || !smtpHost || !smtpPort) return null;
	return {
		imapHost,
		imapPort,
		isImapSecure: isImplicitTls(incoming),
		smtpHost,
		smtpPort,
		isSmtpSecure: isImplicitTls(outgoing),
	};
}
