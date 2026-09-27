/**
 * Display name for the person a follow-up waits on. Kept out of followUps.ts
 * because needsReply.ts importing that module closes an import cycle.
 */

import { normalizeEmail } from '@owlat/shared';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/** How many messages to scan (per source) for the counterpart's display name. */
const COUNTERPART_NAME_SCAN = 25;

/**
 * Display name for the address a follow-up waits on, so the queue can say
 * "You're waiting on Mei Tanaka" rather than the bare address. Sources, in
 * order: the owner's address book (they may have renamed the contact), the
 * name the counterpart used earlier in this thread, then the name on their
 * most recent mail anywhere in the mailbox. Undefined when none has one.
 *
 * Inbound `fromAddress` keeps the sender's casing, so thread messages are
 * compared case-insensitively and the mailbox-wide index is tried with both
 * the stored and the lowercased spelling.
 */
export async function resolveCounterpartName(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	threadId: Id<'mailThreads'>,
	address: string | undefined
): Promise<string | undefined> {
	if (!address) return undefined;
	const email = normalizeEmail(address);
	const contact = await ctx.db
		.query('mailContacts')
		.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailboxId).eq('email', email))
		.first();
	const saved = contact?.displayName?.trim();
	if (saved) return saved;

	const nameFrom = (messages: Doc<'mailMessages'>[]) =>
		messages
			.filter((m) => normalizeEmail(m.fromAddress) === email)
			.map((m) => m.fromName?.trim())
			.find((n) => !!n);

	const inThread = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(COUNTERPART_NAME_SCAN);
	const threadName = nameFrom(inThread);
	if (threadName) return threadName;

	for (const from of new Set([address.trim(), email])) {
		const recent = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_from', (q) => q.eq('mailboxId', mailboxId).eq('fromAddress', from))
			.order('desc')
			.take(COUNTERPART_NAME_SCAN);
		const name = nameFrom(recent);
		if (name) return name;
	}
	return undefined;
}
