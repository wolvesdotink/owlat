/**
 * Mail-server autodiscovery, the pure half: which domain an address names, where
 * its autoconfig document lives, and what the document says.
 *
 * The network half is `autodiscoverActions.ts`. The lookups run on the backend
 * because the web app's CSP lets the browser reach no third-party endpoint. The
 * document is read with the XML subset parser in `lib/xmlSubset.ts`.
 */

import { descendants, parseXml, textContent, type XmlElement } from '../../lib/xmlSubset';

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
	const root = parseXml(xml);
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
