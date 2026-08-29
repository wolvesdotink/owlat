/**
 * The member-readable sending-health read (plan idea 12).
 *
 * Its own file rather than a sixth handler in `mailbox/queries.ts`: that module
 * is the mailbox LIST views (message list, thread list, folder sidebar, switcher,
 * unread badge) and this is an AGGREGATE over the sent folder, asked by
 * preferences rather than by the mail list. Splitting it also keeps `queries.ts`
 * under the 500-LOC cap CONVENTIONS.md asks for.
 *
 * Siblings: `mailbox/identity.ts` (CRUD + provisioning), `mailbox/queries.ts`
 * (list views), `mailbox/messages.ts` (single-message reads, including the
 * thread's per-recipient outbound delivery), `mailbox/search.ts`.
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import { loadReadableMailbox } from '../permissions';

/** How many of the newest sent-folder rows the health read inspects. */
const SENDING_HEALTH_WINDOW = 100;

/**
 * How the caller's OWN recent sends actually landed — the bounce half of the
 * personal sending-health card (plan idea 12).
 *
 * Member-scoped by construction: it reads one mailbox the caller can already
 * open, over the `sent` system folder, and returns nothing but counts plus the
 * single most recent failure. No org-wide reputation, no admin-gated
 * deliverability data — a member who cannot open the Delivery hub still gets an
 * honest answer to "is my mail arriving?".
 *
 * Counts RECIPIENTS, not messages: a two-recipient send where one address
 * bounced is one bounce out of two attempts, and rolling it up to the message
 * would either hide it or double it. `sends` is how many sent messages the
 * window covered, so the card can say "2 of your last 40 sends" honestly.
 *
 * Bounded: at most `SENDING_HEALTH_WINDOW` rows from the sent folder, newest
 * first. A mailbox with no sent folder (or nothing in it) reports a zero window
 * rather than an error — a brand-new mailbox is not unhealthy, it is untested,
 * and the card renders that difference.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getSendingHealth = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	returns: v.union(
		v.null(),
		v.object({
			/** Sent messages the window covered (<= SENDING_HEALTH_WINDOW). */
			sends: v.number(),
			/** Per-recipient attempts across those messages. */
			attempts: v.number(),
			/** Attempts the MTA handed off without a terminal failure. */
			accepted: v.number(),
			bounced: v.number(),
			failed: v.number(),
			/** Attempts still in flight — neither a success nor a failure yet. */
			pending: v.number(),
			/** The newest terminal failure in the window, for the "one thing to fix" line. */
			latestFailure: v.union(
				v.null(),
				v.object({
					address: v.string(),
					state: v.union(v.literal('bounced'), v.literal('failed')),
					at: v.number(),
					bounceMessage: v.optional(v.string()),
					errorCode: v.optional(v.string()),
				})
			),
		})
	),
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return null;
		const sentFolder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', args.mailboxId).eq('role', 'sent'))
			.first();
		const empty = {
			sends: 0,
			attempts: 0,
			accepted: 0,
			bounced: 0,
			failed: 0,
			pending: 0,
			latestFailure: null,
		};
		if (!sentFolder) return empty;
		const recent = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => q.eq('folderId', sentFolder._id))
			.order('desc')
			.take(SENDING_HEALTH_WINDOW);

		let sends = 0;
		let attempts = 0;
		let accepted = 0;
		let bounced = 0;
		let failed = 0;
		let pending = 0;
		let latestFailure: {
			address: string;
			state: 'bounced' | 'failed';
			at: number;
			bounceMessage?: string;
			errorCode?: string;
		} | null = null;
		for (const message of recent) {
			// A sent-folder row without `outbound` predates the lifecycle module (or
			// was filed by IMAP sync); it carries no delivery evidence either way, so
			// it is left out of BOTH sides of the ratio rather than counted as a win.
			if (!message.outbound) continue;
			sends += 1;
			for (const r of message.outbound.recipients) {
				attempts += 1;
				if (r.state === 'bounced' || r.state === 'failed') {
					const at = (r.state === 'bounced' ? r.bouncedAt : r.failedAt) ?? message.receivedAt;
					if (r.state === 'bounced') bounced += 1;
					else failed += 1;
					if (!latestFailure || at > latestFailure.at) {
						latestFailure = {
							address: r.address,
							state: r.state,
							at,
							...(r.bounceMessage !== undefined ? { bounceMessage: r.bounceMessage } : {}),
							...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
						};
					}
				} else if (r.state === 'sent') {
					accepted += 1;
				} else {
					pending += 1;
				}
			}
		}
		return { sends, attempts, accepted, bounced, failed, pending, latestFailure };
	},
});
