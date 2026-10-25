/**
 * Today's Upcoming band: everything already set to happen later, in one time
 * order, across every inbox the viewer can open and the workspace's campaigns.
 *
 *   - scheduled sends (a draft in `scheduled`), from each mailbox;
 *   - conversations coming back from snooze, from each mailbox;
 *   - armed "remind me if no reply" follow-ups, from each mailbox;
 *   - Team Inbox conversations coming back from snooze (shared-inbox readers);
 *   - scheduled campaigns (when campaigns are on).
 *
 * Each source answers from its own time-ordered index (`./upcomingSources.ts`)
 * and contributes at most `limit + 1` items: the first `limit` of the union
 * can hold at most `limit` from any one source, so the merged page is exact,
 * and a `limit + 1`-th item anywhere means there is more. A source that could
 * not prove its first items (the snooze scan cap) bounds the page at its
 * horizon instead, so a later item from another source never jumps a
 * conversation the scan did not reach.
 *
 * The page is independent of the Workbench's "since you last looked"
 * watermark and of the inbox picker: a scheduled send from a hidden inbox
 * still goes out, so it is still listed.
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadAccessibleMailboxes } from '../mail/permissions';
import { isSharedInboxReader } from '../inbox/access';
import {
	mailboxRefOf,
	readFollowUps,
	readScheduledCampaigns,
	readScheduledSends,
	readSnoozeReturns,
	readTeamSnoozeReturns,
	type SourceResult,
	type UpcomingItem,
} from './upcomingSources';

export const UPCOMING_DEFAULT_LIMIT = 8;
export const UPCOMING_MAX_LIMIT = 50;

export interface UpcomingPage {
	items: UpcomingItem[];
	/** More is scheduled than the page lists; a larger `limit` shows it. */
	hasMore: boolean;
}

/** Earliest first; the key breaks ties so the order is stable across reruns. */
function byTime(a: UpcomingItem, b: UpcomingItem): number {
	return a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Merge per-source results into one page (see the module comment for why this is exact). */
export function mergeUpcoming(sources: readonly SourceResult[], limit: number): UpcomingPage {
	const horizons = sources.flatMap((s) => (s.horizon === undefined ? [] : [s.horizon]));
	const horizon = horizons.length > 0 ? Math.min(...horizons) : undefined;
	const all = sources.flatMap((s) => s.items).sort(byTime);
	const reachable = horizon === undefined ? all : all.filter((item) => item.at <= horizon);
	return {
		items: reachable.slice(0, limit),
		hasMore: reachable.length > limit || horizon !== undefined,
	};
}

/**
 * The viewer's upcoming page. Mail comes only from the mailboxes the viewer
 * can open (their own and the shared ones they belong to, in the active
 * organization, active ones only; none when personal mail is off), Team Inbox
 * snoozes only for shared-inbox readers with the Team Inbox on, and campaigns
 * only with campaigns on.
 */
// authz: each source is gated in the handler — mailboxes through
// loadAccessibleMailboxes (the inbox switcher's set), Team Inbox snoozes through
// isSharedInboxReader + the `inbox` flag, campaigns (readable by every member)
// through the `campaigns` flag.
export const list = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args, session): Promise<UpcomingPage> => {
		const limit = Math.max(
			1,
			Math.min(Math.floor(args.limit ?? UPCOMING_DEFAULT_LIMIT), UPCOMING_MAX_LIMIT)
		);
		const want = limit + 1;
		const now = Date.now();
		const sources: SourceResult[] = [];

		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		for (const mailbox of mailboxes) {
			if (mailbox.status !== 'active') continue;
			const ref = mailboxRefOf(mailbox);
			sources.push(
				await readScheduledSends(ctx, ref, want),
				await readSnoozeReturns(ctx, ref, want, now),
				await readFollowUps(ctx, ref, want, now)
			);
		}
		if (isSharedInboxReader(session) && (await isFeatureEnabled(ctx, 'inbox'))) {
			sources.push(await readTeamSnoozeReturns(ctx, want, now));
		}
		if (await isFeatureEnabled(ctx, 'campaigns')) {
			sources.push(await readScheduledCampaigns(ctx, want));
		}
		return mergeUpcoming(sources, limit);
	},
});
