/**
 * The addresses a mailbox itself sends and receives as, read without the
 * transport and domain imports `identities.ts` carries, so read-only arrival
 * modules (`arrival/coldPitchEvidence.ts`, which the projection imports) can
 * use it without an import cycle. `identities.ts` re-exports it.
 *
 * Isolate-safe; not a Convex function.
 */

import { normalizeEmail } from '@owlat/shared';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

/**
 * Every address the mailbox itself sends and receives as: its canonical address
 * plus each alias that targets it, normalized. Unlike the From allow-set in
 * `identities.ts` it ignores the mailbox's status, so delivery threading (which
 * runs for any mailbox that still receives mail) sees the same identities the
 * composer does.
 */
export async function mailboxOwnAddresses(
	ctx: Pick<QueryCtx, 'db'>,
	mailbox: Doc<'mailboxes'>
): Promise<Set<string>> {
	const aliases = await ctx.db
		.query('mailAliases')
		.withIndex('by_target', (q) => q.eq('targetMailboxId', mailbox._id))
		.collect(); // bounded: aliases pointing at one target
	const set = new Set<string>([normalizeEmail(mailbox.address)]);
	for (const a of aliases) set.add(normalizeEmail(a.alias));
	return set;
}
