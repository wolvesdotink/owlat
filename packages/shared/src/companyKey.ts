/**
 * Which company an email address belongs to.
 *
 * A company is keyed by the organisational domain of its people's addresses,
 * so `jonas@mail.northwind.example` and `mira@northwind.example` are the same
 * company. Shared because the backend keys its company index with it and the
 * web app links to a company by the same key.
 *
 * Three kinds of address belong to no company and get `null`:
 *   - free-mail addresses (gmail.com, gmx.de, …): two Gmail users have nothing
 *     in common but their provider;
 *   - the workspace's own domains: colleagues are not a customer;
 *   - anything without a usable domain.
 */

import { organizationalDomain } from './dnsZone';
import { isFreemailDomain } from './freemailDomains';

/** The part after the last `@`, trimmed, lowercased, without a trailing dot. */
function addressDomain(address: string): string | null {
	const trimmed = address.trim().replace(/^<|>$/g, '');
	const at = trimmed.lastIndexOf('@');
	if (at < 1 || at === trimmed.length - 1) return null;
	return trimmed
		.slice(at + 1)
		.toLowerCase()
		.replace(/\.+$/, '');
}

/** The organisational domain of a mail domain, or `null` when it has none. */
export function companyKeyOfDomain(domain: string): string | null {
	const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
	if (!normalized || isFreemailDomain(normalized)) return null;
	const org = organizationalDomain(normalized);
	if (org === null || isFreemailDomain(org)) return null;
	return org;
}

/**
 * The company key of an address, or `null` for free-mail, own and malformed
 * addresses. `ownDomains` holds organisational domains (see
 * {@link companyKeyOfDomain}); a key found in it is the workspace itself.
 */
export function companyKeyOf(address: string, ownDomains?: ReadonlySet<string>): string | null {
	const domain = addressDomain(address);
	if (domain === null) return null;
	const key = companyKeyOfDomain(domain);
	if (key === null || ownDomains?.has(key)) return null;
	return key;
}

/**
 * A readable name for a company nobody has named yet, from its key:
 * `northwind-logistics.example` reads as "Northwind Logistics".
 */
export function companyNameFromKey(key: string): string {
	const label = key.split('.')[0] ?? key;
	const words = label.split(/[-_]+/).filter(Boolean);
	if (words.length === 0) return key;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
