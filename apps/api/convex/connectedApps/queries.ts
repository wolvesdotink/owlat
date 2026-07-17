/**
 * Connected-app read surface. Every result is projected through
 * `toPublicConnectedApp`, so the sealed hook secret is never returned to a
 * client — not on list, not on get, not ever after the one-time reveal.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { toPublicConnectedApp, type PublicConnectedApp } from './model';
import type { ConnectedAppStatus } from './lifecycle';
import { loadConnectedAppInOrg } from './repository';

/** Max connected apps returned in one list page — the table is tiny per org. */
const MAX_CONNECTED_APPS = 200;

/** List the active organization's connected apps, newest first. Secret-free. */
export const listByTeam = authedQuery({
	args: {},
	handler: async (ctx): Promise<PublicConnectedApp[]> => {
		const { activeOrganizationId } = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view connected apps'
		);
		const rows = await ctx.db
			.query('connectedApps')
			.withIndex('by_organization_id', (index) => index.eq('organizationId', activeOrganizationId))
			.order('desc')
			.take(MAX_CONNECTED_APPS);
		return rows.map(toPublicConnectedApp);
	},
});

/** Fetch a single connected app in the active org. Cross-tenant ids 404. */
export const get = authedQuery({
	args: { connectedAppId: v.id('connectedApps') },
	handler: async (ctx, args): Promise<PublicConnectedApp> => {
		const { activeOrganizationId } = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view connected apps'
		);
		const row = await loadConnectedAppInOrg(ctx, args.connectedAppId, activeOrganizationId);
		return toPublicConnectedApp(row);
	},
});

/**
 * Load the tenant-scoped endpoint + status for the connection-test action.
 * Internal-only: the Node action (`connectedApps/actions.testConnection`) runs
 * this in the caller's propagated session to re-gate owner/admin and resolve the
 * endpoint without exposing any secret material. Returns only what the probe
 * needs — never the sealed secret columns.
 */
export const _loadEndpointForTest = internalQuery({
	args: { connectedAppId: v.id('connectedApps') },
	handler: async (
		ctx,
		args
	): Promise<{ endpointUrl: string; status: ConnectedAppStatus }> => {
		const { activeOrganizationId } = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can test connected apps'
		);
		const row = await loadConnectedAppInOrg(ctx, args.connectedAppId, activeOrganizationId);
		return { endpointUrl: row.endpointUrl, status: row.status };
	},
});
