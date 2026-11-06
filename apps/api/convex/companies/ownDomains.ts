/**
 * The workspace's own organisational domains: the domains of its mailboxes and
 * of its sending domains. Addresses there are colleagues, never a company the
 * workspace talks to.
 */

import { companyKeyOfDomain } from '@owlat/shared/companyKey';
import type { QueryCtx } from '../_generated/server';

/** Far above any real number of mailboxes or sending domains in one workspace. */
const MAX_ROWS = 1000;

function domainOfAddress(address: string): string | null {
	const at = address.lastIndexOf('@');
	return at < 0 ? null : address.slice(at + 1);
}

export async function loadOwnDomains(ctx: QueryCtx): Promise<Set<string>> {
	const own = new Set<string>();
	const add = (domain: string | null | undefined) => {
		if (!domain) return;
		const key = companyKeyOfDomain(domain);
		if (key) own.add(key);
	};
	const mailboxes = await ctx.db
		.query('mailboxes')
		.withIndex('by_status', (q) => q.eq('status', 'active'))
		.take(MAX_ROWS);
	for (const mailbox of mailboxes) {
		// An external mailbox on a free-mail provider adds nothing (the key is
		// null); one on a company domain makes that domain the workspace's own.
		add(domainOfAddress(mailbox.address));
	}
	const sendingDomains = await ctx.db.query('domains').take(MAX_ROWS); // bounded: a workspace's sending domains
	for (const row of sendingDomains) add(row.domain);
	return own;
}
