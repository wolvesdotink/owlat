/**
 * Resolve the set of From addresses a mailbox is authorised to send as.
 *
 * Returns the mailbox's canonical address plus every alias that targets
 * it. Comparison is lowercase exact-match on the canonical address only —
 * display names are not part of the allow-set.
 *
 * Used as the load-bearing identity check at three boundaries:
 *   - draft dispatch (`mailDraftLifecycle.transition` `→ sent` reducer)
 *   - IMAP APPEND (`mailImap.appendMessage`)
 *   - explicit identity selection (`mailDrafts.setIdentity`, slice 3)
 *
 * Exposed both as a shared TypeScript helper (for v8 mutations that
 * already have a ctx) and as an internalQuery (for `'use node'` actions
 * that need to round-trip through Convex).
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { loadReadableMailbox } from './permissions';

function canonical(addr: string): string {
	return addr.trim().toLowerCase();
}

/**
 * Shared helper for v8 mutations/queries: read the allowed-from set
 * directly from the ctx without an extra runQuery hop.
 */
export async function resolveAllowedFromAddressesForCtx(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<string[]> {
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox || mailbox.status !== 'active') return [];
	const aliases = await ctx.db
		.query('mailAliases')
		.withIndex('by_target', (q) => q.eq('targetMailboxId', mailboxId))
		.collect();
	const set = new Set<string>();
	set.add(canonical(mailbox.address));
	for (const a of aliases) set.add(canonical(a.alias));
	return Array.from(set);
}

/** Internal query for `'use node'` actions / out-of-isolate callers. */
export const resolveAllowedFromAddresses = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<string[]> => {
		return resolveAllowedFromAddressesForCtx(ctx, args.mailboxId);
	},
});

/** Public query for the web composer's identity dropdown. */
// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const listForOwnedMailbox = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<string[]> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];
		return resolveAllowedFromAddressesForCtx(ctx, args.mailboxId);
	},
});
