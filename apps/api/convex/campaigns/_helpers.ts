/**
 * Feature-gated function builders for the campaigns module.
 *
 * They compose the org-member auth floor (`authedQuery` / `authedMutation`)
 * with the `campaigns` feature floor, so a handler in `campaigns/**` no longer
 * repeats `assertFeatureEnabled(ctx, 'campaigns')` by hand
 * (`scripts/check-feature-floors.sh` fails on a new inline copy). The
 * `campaigns:*` permission checks and the draft/lifecycle guards still live in
 * the handler; the floor here decides only whether the surface exists on this
 * instance. The web gates `/dashboard/campaigns` and `/dashboard/marketing` on
 * the same flag.
 *
 * NOT for every function under `campaigns/`. A function whose web caller
 * renders outside the campaigns routes keeps its builder and says why with a
 * `// flag-exempt: <reason>` comment:
 *   - the sender directory (`senders.ts`), managed from the team admin page;
 *   - the sending-readiness summary the dashboard's getting-started card reads;
 *   - the template test send, which the template and transactional editors use.
 * `internal*` functions are untouched: the scheduler and the send pipeline run
 * with no user session and must finish what is already queued.
 *
 * Actions have no `ctx.db`, so they cannot be wrapped: a campaign action calls
 * `assertCampaignsEnabledInAction` at the top instead.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `campaigns/**` modules.
 * V8-safe: the `'use node'` test-send module imports it.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { authedQuery, authedMutation, featureGated } from '../lib/authedFunctions';
import { throwFeatureDisabled } from '../lib/featureFlags';

export const campaignsQuery = featureGated(authedQuery, 'campaigns');
export const campaignsMutation = featureGated(authedMutation, 'campaigns');

/** The action-side `campaigns` floor: refuse the call unless the flag is on. */
export async function assertCampaignsEnabledInAction(
	ctx: Pick<ActionCtx, 'runQuery'>
): Promise<void> {
	const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	if (!flags.campaigns) throwFeatureDisabled('campaigns');
}
