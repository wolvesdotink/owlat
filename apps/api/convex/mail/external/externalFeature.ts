/**
 * The `mail.external` feature floor for ACTIONS.
 *
 * Actions have no `ctx.db`, so they cannot call `assertFeatureEnabled` the way a
 * query/mutation does — they resolve the flag through the internal mirror query
 * instead. Extracted out of `accountsActions.ts` so the Google sign-in actions
 * enforce the SAME gate by importing it rather than restating it (a second copy
 * is how one connect path ends up reachable on an instance where the feature is
 * off). V8-safe on purpose: both `'use node'` action files import it.
 */

import { internal } from '../../_generated/api';
import { throwForbidden } from '../../_utils/errors';
import type { ActionCtx } from '../../_generated/server';

/** Refuse the call unless the instance has external mailboxes enabled. */
export async function assertExternalEnabled(ctx: ActionCtx): Promise<void> {
	const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	if (!flags['mail.external']) {
		throwForbidden(
			'Feature "mail.external" is disabled on this Owlat instance. An admin can enable it from Settings → Features.',
			{ feature: 'mail.external' }
		);
	}
}
