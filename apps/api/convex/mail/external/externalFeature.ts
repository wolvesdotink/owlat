/**
 * The `mail.external` feature floor — one module for every function shape.
 *
 * Queries and mutations compose the floor into their builder:
 * `externalMailQuery`, `externalMailMutation` and `externalMailAdminMutation`
 * are `featureGated` wrappers over `authedQuery`, `authedMutation` and
 * `adminMutation`. The flag check runs after the builder's auth floor and before
 * the handler, so a handler in the family no longer repeats
 * `assertFeatureEnabled(ctx, 'mail.external')` by hand
 * (`scripts/check-feature-floors.sh` fails on a new inline copy).
 *
 * The soft-auth `publicQuery` reads (mailboxMove.moveStatus,
 * accounts.getForCurrentUser, migration.getStatus,
 * sendingSwitch.sendingSwitchStatus) keep an inline assert marked
 * `// flag-inline:`: a gated `publicQuery` would slip past
 * check-public-functions and its `// public:` rule.
 *
 * Actions have no `ctx.db`, so they cannot call `assertFeatureEnabled` the way a
 * query/mutation does — `assertExternalEnabled` resolves the flag through the
 * internal mirror query instead. The Google sign-in actions import it rather
 * than restating it (a second copy is how one connect path ends up reachable on
 * an instance where the feature is off).
 *
 * V8-safe on purpose: both `'use node'` action files import it, and it depends
 * only on the V8 builder and feature-flag modules and the generated API.
 */

import { internal } from '../../_generated/api';
import { throwFeatureDisabled } from '../../lib/featureFlags';
import type { ActionCtx } from '../../_generated/server';
import {
	adminMutation,
	authedMutation,
	authedQuery,
	featureGated,
} from '../../lib/authedFunctions';

/** An org-member read that exists only while external mailboxes are enabled. */
export const externalMailQuery = featureGated(authedQuery, 'mail.external');

/** An org-member write that exists only while external mailboxes are enabled. */
export const externalMailMutation = featureGated(authedMutation, 'mail.external');

/** An admin write (`organization:manage`) behind the same `mail.external` floor. */
export const externalMailAdminMutation = featureGated(adminMutation, 'mail.external');

/** Refuse the call unless the instance has external mailboxes enabled. */
export async function assertExternalEnabled(ctx: ActionCtx): Promise<void> {
	const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	if (!flags['mail.external']) throwFeatureDisabled('mail.external');
}
