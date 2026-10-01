/**
 * The backfill walk behind the IMAP folder membership (#927).
 *
 * A folder that held mail before its membership was maintained is filled by
 * walking `by_folder_and_uid` one bounded page per mutation, rescheduling itself
 * until the folder is ready; `mail/folderMembership.ts` explains why writes that
 * race the walk still land exactly once. Progress is durable: the cursor and
 * watermark live on the folder's `mailFolderMembership` row, so a walk that
 * dies (a failed step, a redeploy mid-chain) resumes from its last page when it
 * is kicked again, and a second chain beside the first only takes turns with it.
 *
 * Started for existing folders by `migrations/0054_backfill_folder_membership`;
 * a new folder starts ready (`startFolderMembership(…, { isEmpty: true })`).
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { runFolderMembershipBackfillStep } from '../mail/folderMembership';

export const step = internalMutation({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, { folderId }) => {
		if (await runFolderMembershipBackfillStep(ctx, folderId)) {
			await ctx.scheduler.runAfter(0, internal.maintenance.folderMembershipBackfill.step, {
				folderId,
			});
		}
	},
});
