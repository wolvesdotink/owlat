/**
 * The Senders page reads (`/dashboard/postbox/senders`).
 *
 *   - `list({mailboxId, tab, paginationOpts})`: All (newest delivery first,
 *     `by_mailbox_last`) or one status (`by_mailbox_status_last`), paginated.
 *   - `review({mailboxId})`: the To review tab and its count, the suggestions
 *     from the bounded `keep` scan in `./suggestions.ts`.
 *
 * Counters are rolled to now on read, so a sender that went quiet shows its
 * window as it stands today. Personal mailboxes only; anything else reads as
 * empty.
 */

import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { MutationSessionContext } from '../../lib/sessionOrganization';
import { postboxQuery } from '../_helpers';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import { senderWindowTotals } from './counters';
import { listSenderSuggestions, type SenderSuggestion } from './suggestions';

/** Rows the To review tab shows. */
const REVIEW_ROWS = 100;

export interface SenderRow {
	senderDigest: string;
	address: string;
	displayName?: string;
	status: Doc<'mailSenderProfiles'>['status'];
	statusSource: Doc<'mailSenderProfiles'>['statusSource'];
	kind?: Doc<'mailSenderProfiles'>['kind'];
	/** Over the window ("about 90 days"). */
	delivered: number;
	opened: number;
	lastDeliveredAt?: number;
	unsubscribe?: Doc<'mailSenderProfiles'>['unsubscribe'];
	/** Lane drafts paused auto-drafts for this sender (§7). */
	autoDraftPausedAt?: number;
	suggestion?: SenderSuggestion;
}

export function senderRowOf(
	profile: Doc<'mailSenderProfiles'>,
	now: number,
	suggestion?: SenderSuggestion
): SenderRow {
	const totals = senderWindowTotals(profile, now);
	return {
		senderDigest: profile.senderDigest,
		address: profile.address,
		...(profile.displayName ? { displayName: profile.displayName } : {}),
		status: profile.status,
		statusSource: profile.statusSource,
		...(profile.kind ? { kind: profile.kind } : {}),
		delivered: totals.delivered,
		opened: totals.opened,
		...(profile.lastDeliveredAt !== undefined ? { lastDeliveredAt: profile.lastDeliveredAt } : {}),
		...(profile.unsubscribe ? { unsubscribe: profile.unsubscribe } : {}),
		...(profile.autoDraftPausedAt !== undefined
			? { autoDraftPausedAt: profile.autoDraftPausedAt }
			: {}),
		...(suggestion ? { suggestion } : {}),
	};
}

async function readablePersonalMailbox(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	session: MutationSessionContext
): Promise<boolean> {
	const owned = await requireMailboxAccess(ctx, mailboxId, 'member', session);
	return owned.ok && isPersonalMailbox(owned.mailbox);
}

const tabValidator = v.union(
	v.literal('all'),
	v.literal('digest'),
	v.literal('auto_archive'),
	v.literal('unsubscribed')
);

// authz: requireMailboxAccess on the mailbox; personal mailboxes only.
export const list = postboxQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		tab: tabValidator,
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args, session) => {
		if (!(await readablePersonalMailbox(ctx, args.mailboxId, session))) {
			return { page: [] as SenderRow[], isDone: true, continueCursor: '' };
		}
		const { tab } = args;
		const query =
			tab === 'all'
				? ctx.db
						.query('mailSenderProfiles')
						.withIndex('by_mailbox_last', (q) => q.eq('mailboxId', args.mailboxId))
				: ctx.db
						.query('mailSenderProfiles')
						.withIndex('by_mailbox_status_last', (q) =>
							q.eq('mailboxId', args.mailboxId).eq('status', tab)
						);
		const result = await query.order('desc').paginate(args.paginationOpts);
		const now = Date.now();
		return { ...result, page: result.page.map((profile) => senderRowOf(profile, now)) };
	},
});

// authz: requireMailboxAccess on the mailbox; personal mailboxes only.
export const review = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args, session): Promise<{ rows: SenderRow[]; total: number }> => {
		if (!(await readablePersonalMailbox(ctx, args.mailboxId, session))) {
			return { rows: [], total: 0 };
		}
		const now = Date.now();
		const suggested = await listSenderSuggestions(ctx, args.mailboxId, now);
		return {
			rows: suggested
				.slice(0, REVIEW_ROWS)
				.map(({ profile, suggestion }) => senderRowOf(profile, now, suggestion)),
			total: suggested.length,
		};
	},
});
