/**
 * Connected-app write surface.
 *
 *   Public:   enable / disable / revoke / remove  — lifecycle edges, each
 *             owner/admin-gated and audited.
 *   Internal: _insertConnectedApp / _rotateConnectedAppSecret — the secret-bearing
 *             writes, called ONLY from the Node action layer (connectedApps/actions.ts)
 *             which seals the plaintext before it ever reaches the database.
 *
 * The sealed secret columns are written here but never read back to a client;
 * queries project through `toPublicConnectedApp`. Audit details carry a redacted
 * scalar summary (pluginId + capability count) and never the secret.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { throwInvalidState } from '../_utils/errors';
import {
	toPublicConnectedApp,
	validateConnectedAppEndpoint,
	validateConnectedAppName,
	validateGrantedCapabilities,
	type PublicConnectedApp,
} from './model';
import {
	isConnectedAppRevoked,
	nextConnectedAppStatus,
	type ConnectedAppTransition,
} from './lifecycle';
import { loadConnectedAppInOrg } from './repository';

const MANAGE_PERMISSION = 'organization:manage' as const;
const MANAGE_MESSAGE = 'Only owners and admins can manage connected apps';

/** Sealed-secret envelope columns shared by insert and rotate. */
const secretEnvelopeArgs = {
	secretCiphertext: v.string(),
	secretIv: v.string(),
	secretAuthTag: v.string(),
	secretEnvelopeVersion: v.number(),
} as const;

/** Redacted lifecycle audit: pluginId + capability count only, never the secret. */
async function recordConnectedAppAudit(
	ctx: MutationCtx,
	params: {
		userId: string;
		organizationId: string;
		action: AuditAction;
		connectedAppId: Id<'connectedApps'>;
		pluginId: string;
		capabilityCount: number;
	}
): Promise<void> {
	await recordAuditLog(ctx, {
		userId: params.userId,
		organizationId: params.organizationId,
		pluginId: params.pluginId,
		action: params.action,
		resource: 'connected_app',
		resourceId: params.connectedAppId,
		details: { pluginId: params.pluginId, capabilityCount: params.capabilityCount },
	});
}

/** Apply a status→status lifecycle edge, or fail closed on an illegal request. */
async function applyLifecycleTransition(
	ctx: MutationCtx,
	connectedAppId: Id<'connectedApps'>,
	transition: ConnectedAppTransition,
	action: AuditAction
): Promise<{ success: true }> {
	const { userId, activeOrganizationId } = await requireOrgPermission(
		ctx,
		MANAGE_PERMISSION,
		MANAGE_MESSAGE
	);
	const app = await loadConnectedAppInOrg(ctx, connectedAppId, activeOrganizationId);
	const next = nextConnectedAppStatus(app.status, transition);
	if (next === null) {
		throwInvalidState(`Cannot ${transition} a connected app in state "${app.status}"`);
	}
	const now = Date.now();
	await ctx.db.patch(connectedAppId, {
		status: next,
		updatedAt: now,
		...(transition === 'revoke' ? { revokedAt: now } : {}),
	});
	await recordConnectedAppAudit(ctx, {
		userId,
		organizationId: activeOrganizationId,
		action,
		connectedAppId,
		pluginId: app.pluginId,
		capabilityCount: app.grantedCapabilities.length,
	});
	return { success: true };
}

/** Re-enable a disabled app. Illegal on an enabled or revoked app. */
// authz: owner/admin gate (requireOrgPermission 'organization:manage') is baked
// into applyLifecycleTransition, the shared helper every edge runs through.
export const enable = authedMutation({
	args: { connectedAppId: v.id('connectedApps') },
	handler: (ctx, args) =>
		applyLifecycleTransition(ctx, args.connectedAppId, 'enable', 'connected_app.enabled'),
});

/** Temporarily disable an enabled app. Illegal on a disabled or revoked app. */
// authz: owner/admin gate baked into applyLifecycleTransition (see enable).
export const disable = authedMutation({
	args: { connectedAppId: v.id('connectedApps') },
	handler: (ctx, args) =>
		applyLifecycleTransition(ctx, args.connectedAppId, 'disable', 'connected_app.disabled'),
});

/**
 * Revoke an app: one-way kill switch. The sealed secret is retained for audit
 * history but is cryptographically dead — a revoked app can never re-enable and
 * its secret can never rotate.
 */
// authz: owner/admin gate baked into applyLifecycleTransition (see enable).
export const revoke = authedMutation({
	args: { connectedAppId: v.id('connectedApps') },
	handler: (ctx, args) =>
		applyLifecycleTransition(ctx, args.connectedAppId, 'revoke', 'connected_app.revoked'),
});

/** Permanently delete a connected-app record. Legal from any status. */
export const remove = authedMutation({
	args: { connectedAppId: v.id('connectedApps') },
	handler: async (ctx, args): Promise<{ success: true }> => {
		const { userId, activeOrganizationId } = await requireOrgPermission(
			ctx,
			MANAGE_PERMISSION,
			MANAGE_MESSAGE
		);
		const app = await loadConnectedAppInOrg(ctx, args.connectedAppId, activeOrganizationId);
		await ctx.db.delete(args.connectedAppId);
		await recordConnectedAppAudit(ctx, {
			userId,
			organizationId: activeOrganizationId,
			action: 'connected_app.deleted',
			connectedAppId: args.connectedAppId,
			pluginId: app.pluginId,
			capabilityCount: app.grantedCapabilities.length,
		});
		return { success: true };
	},
});

/**
 * Insert a connected-app record with an already-sealed secret envelope. Internal:
 * the Node action layer seals the plaintext and calls this in the caller's
 * session, which is re-gated to owner/admin here (the action floor is only
 * "authenticated member"). New apps start `enabled`.
 */
export const _insertConnectedApp = internalMutation({
	args: {
		pluginId: v.string(),
		name: v.string(),
		endpointUrl: v.string(),
		grantedCapabilities: v.array(v.string()),
		...secretEnvelopeArgs,
	},
	handler: async (ctx, args): Promise<PublicConnectedApp> => {
		const { userId, activeOrganizationId } = await requireOrgPermission(
			ctx,
			MANAGE_PERMISSION,
			MANAGE_MESSAGE
		);
		const name = validateConnectedAppName(args.name);
		const endpointUrl = validateConnectedAppEndpoint(args.endpointUrl);
		const grantedCapabilities = validateGrantedCapabilities(
			args.pluginId,
			args.grantedCapabilities
		);

		const now = Date.now();
		const connectedAppId = await ctx.db.insert('connectedApps', {
			organizationId: activeOrganizationId,
			pluginId: args.pluginId,
			name,
			endpointUrl,
			status: 'enabled',
			grantedCapabilities,
			secretCiphertext: args.secretCiphertext,
			secretIv: args.secretIv,
			secretAuthTag: args.secretAuthTag,
			secretEnvelopeVersion: args.secretEnvelopeVersion,
			secretRotatedAt: now,
			createdByUserId: userId,
			createdAt: now,
			updatedAt: now,
		});
		await recordConnectedAppAudit(ctx, {
			userId,
			organizationId: activeOrganizationId,
			action: 'connected_app.registered',
			connectedAppId,
			pluginId: args.pluginId,
			capabilityCount: grantedCapabilities.length,
		});
		const row = await ctx.db.get(connectedAppId);
		return toPublicConnectedApp(row!);
	},
});

/**
 * Replace a connected app's sealed secret with a freshly-sealed envelope.
 * Internal: the Node action mints + seals the new plaintext. Illegal on a
 * revoked app — revocation is terminal, so a dead secret can never rotate back
 * to life.
 */
export const _rotateConnectedAppSecret = internalMutation({
	args: {
		connectedAppId: v.id('connectedApps'),
		...secretEnvelopeArgs,
	},
	handler: async (ctx, args): Promise<{ success: true }> => {
		const { userId, activeOrganizationId } = await requireOrgPermission(
			ctx,
			MANAGE_PERMISSION,
			MANAGE_MESSAGE
		);
		const app = await loadConnectedAppInOrg(ctx, args.connectedAppId, activeOrganizationId);
		if (isConnectedAppRevoked(app.status)) {
			throwInvalidState('Cannot rotate the secret of a revoked connected app');
		}
		const now = Date.now();
		await ctx.db.patch(args.connectedAppId, {
			secretCiphertext: args.secretCiphertext,
			secretIv: args.secretIv,
			secretAuthTag: args.secretAuthTag,
			secretEnvelopeVersion: args.secretEnvelopeVersion,
			secretRotatedAt: now,
			updatedAt: now,
		});
		await recordConnectedAppAudit(ctx, {
			userId,
			organizationId: activeOrganizationId,
			action: 'connected_app.secret_rotated',
			connectedAppId: args.connectedAppId,
			pluginId: app.pluginId,
			capabilityCount: app.grantedCapabilities.length,
		});
		return { success: true };
	},
});
