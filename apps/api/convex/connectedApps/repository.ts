/**
 * Connected-app row access with mandatory tenant scoping.
 *
 * Every read/write path resolves a row through {@link loadConnectedAppInOrg},
 * which hard-fails a cross-tenant id with the same `not_found` a truly missing
 * row produces — a caller in org A can neither read nor mutate org B's app, and
 * cannot distinguish "wrong tenant" from "no such app".
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { throwNotFound } from '../_utils/errors';

/**
 * Load a connected app and assert it belongs to `organizationId`. Throws the
 * standard `not_found` error when the row is missing OR owned by another tenant,
 * so cross-tenant access is denied without leaking existence.
 */
export async function loadConnectedAppInOrg(
	ctx: QueryCtx | MutationCtx,
	appId: Id<'connectedApps'>,
	organizationId: string
): Promise<Doc<'connectedApps'>> {
	const row = await ctx.db.get(appId);
	if (!row || row.organizationId !== organizationId) {
		throwNotFound('Connected app');
	}
	return row;
}
