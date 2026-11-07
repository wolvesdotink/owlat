/**
 * CardDAV (RFC 6352) over WebDAV (RFC 4918) and its sync report (RFC 6578),
 * the pure half: the request bodies the sync sends and the reading of the
 * multistatus answers. The network half is `contactsCardDavActions.ts`.
 *
 * Every answer comes from a server the user named and is untrusted. The XML
 * reader refuses DOCTYPEs and entity definitions (`lib/xmlSubset.ts`), and
 * every href an answer names is resolved against the URL it answered and must
 * stay on that URL's origin: the sync sends the user's password with each
 * request, so a server must not be able to point it at another host.
 */

import {
	childrenNamed,
	descendantsNamed,
	localName,
	parseXml,
	textContent,
	type XmlElement,
} from '../lib/xmlSubset';

const DAV_NAMESPACES =
	'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** PROPFIND Depth 0 on the URL the user gave: who they are and what the URL is. */
export const PROPFIND_CONTEXT_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NAMESPACES}><d:prop><d:current-user-principal/><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

/** PROPFIND Depth 0 on the principal: where its address books live. */
export const PROPFIND_HOME_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NAMESPACES}><d:prop><card:addressbook-home-set/></d:prop></d:propfind>`;

/** PROPFIND Depth 1 on the address-book home: the books in it. */
export const PROPFIND_BOOKS_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NAMESPACES}><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

/** PROPFIND Depth 0 on the book: its change tag, for servers without the sync report. */
export const PROPFIND_CTAG_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NAMESPACES}><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;

/** PROPFIND Depth 1 on the book: every card's etag, the listing without the sync report. */
export const PROPFIND_ETAGS_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NAMESPACES}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`;

/**
 * The sync report (sent with Depth 0). No token asks for every member; a token
 * from the last answer asks for what changed since.
 */
export function syncCollectionBody(syncToken: string | null): string {
	const token = syncToken ? escapeXmlText(syncToken) : '';
	return `<?xml version="1.0" encoding="utf-8"?><d:sync-collection ${DAV_NAMESPACES}><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
}

/** The cards at `hrefs` with their etags and vCard text (sent with Depth 1). */
export function addressbookMultigetBody(hrefs: readonly string[]): string {
	const list = hrefs.map((href) => `<d:href>${escapeXmlText(href)}</d:href>`).join('');
	return `<?xml version="1.0" encoding="utf-8"?><card:addressbook-multiget ${DAV_NAMESPACES}><d:prop><d:getetag/><card:address-data/></d:prop>${list}</card:addressbook-multiget>`;
}

/** One `<d:response>` of a multistatus answer. */
export interface DavResponse {
	/** Absolute URL, on the origin of the URL that answered. */
	url: string;
	/** The response-level status (a sync report's removed member is a 404 here). */
	status: number | null;
	/** The properties a `200` propstat returned, by local name. */
	props: Map<string, XmlElement>;
}

export interface Multistatus {
	responses: DavResponse[];
	/** The sync report's new token, when the answer carried one. */
	syncToken: string | null;
}

/** `HTTP/1.1 404 Not Found` → 404. */
function statusCode(el: XmlElement | undefined): number | null {
	if (!el) return null;
	const match = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(textContent(el));
	return match ? Number(match[1]) : null;
}

/**
 * `href` resolved against `base`, or null when it does not parse or leaves
 * `base`'s origin.
 */
export function resolveSameOrigin(base: string, href: string): string | null {
	try {
		const baseUrl = new URL(base);
		const url = new URL(href.trim(), baseUrl);
		if (url.origin !== baseUrl.origin) return null;
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

/** The same URL whether or not its path ends in a slash. */
export function sameResource(a: string, b: string): boolean {
	const strip = (url: string) => url.replace(/\/+$/, '');
	return strip(a) === strip(b);
}

/**
 * Read a 207 multistatus answer from `base`. Responses whose href leaves the
 * origin are dropped. `null` when the document is not a multistatus.
 */
export function parseMultistatus(xml: string, base: string): Multistatus | null {
	const root = parseXml(xml);
	if (!root || localName(root) !== 'multistatus') return null;
	const responses: DavResponse[] = [];
	for (const response of childrenNamed(root, 'response')) {
		const [hrefEl] = childrenNamed(response, 'href');
		if (!hrefEl) continue;
		const url = resolveSameOrigin(base, textContent(hrefEl));
		if (!url) continue;
		const props = new Map<string, XmlElement>();
		for (const propstat of childrenNamed(response, 'propstat')) {
			const code = statusCode(childrenNamed(propstat, 'status')[0]);
			if (code !== null && (code < 200 || code > 299)) continue;
			for (const prop of childrenNamed(propstat, 'prop')) {
				for (const child of prop.children) {
					if (typeof child !== 'string') props.set(localName(child), child);
				}
			}
		}
		responses.push({ url, status: statusCode(childrenNamed(response, 'status')[0]), props });
	}
	const [tokenEl] = childrenNamed(root, 'sync-token');
	const syncToken = tokenEl ? textContent(tokenEl).trim() || null : null;
	return { responses, syncToken };
}

/** The first href inside a property (`current-user-principal`, `addressbook-home-set`). */
export function propHref(response: DavResponse, prop: string, base: string): string | null {
	const el = response.props.get(prop);
	if (!el) return null;
	const [href] = descendantsNamed(el, 'href');
	return href ? resolveSameOrigin(base, textContent(href)) : null;
}

/** The trimmed text of a property, or null when it is absent or empty. */
export function propText(response: DavResponse, prop: string): string | null {
	const el = response.props.get(prop);
	if (!el) return null;
	return textContent(el).trim() || null;
}

/** Whether the response's `resourcetype` names a CardDAV address book. */
export function isAddressBook(response: DavResponse): boolean {
	const type = response.props.get('resourcetype');
	return !!type && descendantsNamed(type, 'addressbook').length > 0;
}

/** Whether the response's `resourcetype` names any collection. */
export function isCollection(response: DavResponse): boolean {
	const type = response.props.get('resourcetype');
	return !!type && descendantsNamed(type, 'collection').length > 0;
}

/** Where a server publishes its CardDAV context path (RFC 6764). */
export function wellKnownUrl(serverUrl: string): string | null {
	try {
		return new URL('/.well-known/carddav', serverUrl).toString();
	} catch {
		return null;
	}
}

/**
 * A server URL the user typed, normalized: https only, no credentials in it,
 * no fragment. `null` for anything else.
 */
export function normalizeServerUrl(raw: string): string | null {
	const trimmed = raw.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== 'https:' || !url.hostname) return null;
		if (url.username || url.password) return null;
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

/** What a sync report or etag listing says about one card. */
export type CardChange =
	| { kind: 'changed'; url: string; etag: string }
	| { kind: 'removed'; url: string };

/**
 * The card changes in a sync report answer. The book's own entry and members
 * that are collections are skipped. `isTruncated` is a 507 on the book itself,
 * which means "ask again with the new token for the rest".
 */
export function syncReportChanges(
	status: Multistatus,
	bookUrl: string
): { changes: CardChange[]; isTruncated: boolean } {
	const changes: CardChange[] = [];
	let isTruncated = false;
	for (const response of status.responses) {
		if (sameResource(response.url, bookUrl)) {
			if (response.status === 507) isTruncated = true;
			continue;
		}
		if (response.status === 404) {
			changes.push({ kind: 'removed', url: response.url });
			continue;
		}
		if (isCollection(response)) continue;
		const etag = propText(response, 'getetag');
		if (etag) changes.push({ kind: 'changed', url: response.url, etag });
	}
	return { changes, isTruncated };
}

/** Every card in a Depth 1 etag listing of the book, by URL. */
export function listedCardEtags(status: Multistatus, bookUrl: string): Map<string, string> {
	const cards = new Map<string, string>();
	for (const response of status.responses) {
		if (sameResource(response.url, bookUrl) || isCollection(response)) continue;
		const etag = propText(response, 'getetag');
		if (etag) cards.set(response.url, etag);
	}
	return cards;
}

/** The cards of a multiget answer: URL, etag and vCard text. */
export function multigetCards(
	status: Multistatus
): Array<{ url: string; etag: string; vcard: string }> {
	const cards: Array<{ url: string; etag: string; vcard: string }> = [];
	for (const response of status.responses) {
		const etag = propText(response, 'getetag');
		const data = response.props.get('address-data');
		if (!etag || !data) continue;
		cards.push({ url: response.url, etag, vcard: textContent(data) });
	}
	return cards;
}

/** Whether an error answer names the expired-token precondition (RFC 6578 §3.2). */
export function isInvalidSyncTokenError(xml: string): boolean {
	const root = parseXml(xml);
	return !!root && descendantsNamed(root, 'valid-sync-token').length > 0;
}

/** The path of an absolute URL, which is what a multiget's hrefs name. */
export function hrefPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}
