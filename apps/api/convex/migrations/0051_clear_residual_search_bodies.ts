/**
 * Clear deep body-search excerpts on an instance where deep body search is OFF
 * (ADR-0059).
 *
 *   npx convex run migrations/0051_clear_residual_search_bodies:run
 *
 * Opting out is supposed to leave no `mailMessages.searchBody` behind. A sweep
 * run by an earlier release could report completion with excerpts remaining,
 * and that release never swept again once the switch was off. This starts the
 * current, fenced sweep (`mail/_bodySearchLifecycle.beginSearchBodyPurge`),
 * which clears every excerpt in the table page by page in the background.
 *
 * SAFE AT ANY POINT, AND IDEMPOTENT. It does nothing while the switch is on,
 * joins a sweep that is still running instead of starting a second one, and a
 * row without an excerpt costs a read and no write. Progress and completion are
 * on the `mailBodySearchPurges` row (`status`, `scannedCount`, `clearedCount`);
 * a sweep whose page failed is started again by running this once more.
 */

import { internalMutation } from '../lib/writeFence';
import { beginSearchBodyPurge } from '../mail/_bodySearchLifecycle';
import { isBodySearchIndexingEnabled } from '../mail/searchBody';

export const run = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ started: boolean; reason?: string }> => {
		if (await isBodySearchIndexingEnabled(ctx)) {
			return { started: false, reason: 'Deep body search is on; there is nothing to clear' };
		}
		const { started } = await beginSearchBodyPurge(ctx, { isTransition: false });
		return started ? { started } : { started, reason: 'A sweep is already running' };
	},
});
