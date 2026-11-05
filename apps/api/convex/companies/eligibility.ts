/**
 * Which companies a conversation is with. Pure, so the indexer and its tests
 * agree on one rule.
 *
 * A thread counts when it is a conversation: someone in the workspace wrote in
 * it, or the classifiers did not file it as bulk mail. A newsletter from a
 * company is not a relationship with it, and a company list made of every
 * sender of a receipt would bury the people you actually talk to. Spam and
 * trash count for nothing.
 */

import { companyKeyOf } from '@owlat/shared/companyKey';

/** How many participants of one company a row keeps, to show who was involved. */
export const MAX_ADDRESSES_PER_COMPANY = 8;

const BULK_CATEGORIES: ReadonlySet<string> = new Set([
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'spam',
]);
const DISCARDED_ROLES: ReadonlySet<string> = new Set(['spam', 'trash']);

export interface MailThreadShape {
	participants: readonly string[];
	folderRoles: readonly string[];
	category?: { label: string } | undefined;
}

/** Group addresses by company key, dropping free-mail and own addresses. */
export function groupByCompany(
	addresses: readonly string[],
	ownDomains: ReadonlySet<string>
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const raw of addresses) {
		const address = raw.trim().toLowerCase();
		const key = companyKeyOf(address, ownDomains);
		if (key === null) continue;
		const list = out.get(key) ?? [];
		if (list.length < MAX_ADDRESSES_PER_COMPANY && !list.includes(address)) list.push(address);
		out.set(key, list);
	}
	return out;
}

export function isConversation(thread: MailThreadShape): boolean {
	if (thread.folderRoles.some((role) => DISCARDED_ROLES.has(role))) return false;
	if (thread.folderRoles.includes('sent')) return true;
	const label = thread.category?.label;
	return label === undefined || !BULK_CATEGORIES.has(label);
}

/** The companies of a Postbox thread, with the participants at each. */
export function mailThreadCompanies(
	thread: MailThreadShape,
	ownDomains: ReadonlySet<string>
): Map<string, string[]> {
	if (!isConversation(thread)) return new Map();
	return groupByCompany(thread.participants, ownDomains);
}

/**
 * The company of a Team Inbox thread. Only email threads have one: a phone
 * number or a chat handle says nothing about where someone works.
 */
export function teamThreadCompanies(
	thread: { channel?: string | undefined; contactIdentifier?: string | undefined },
	ownDomains: ReadonlySet<string>
): Map<string, string[]> {
	if (thread.channel !== undefined && thread.channel !== 'email') return new Map();
	if (!thread.contactIdentifier) return new Map();
	return groupByCompany([thread.contactIdentifier], ownDomains);
}
