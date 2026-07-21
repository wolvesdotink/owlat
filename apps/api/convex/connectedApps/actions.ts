'use node';

/**
 * Connected-app secret exchange — Node-runtime surface (Tier 2).
 *
 * Runs in Convex's Node.js runtime (`'use node'`) because minting and sealing
 * the shared hook secret uses `node:crypto` (via connectedApps/secretBox). The
 * secret is generated and sealed HERE and only the SEALED envelope crosses into
 * the database (internal mutations in the sibling v8 file `mutations.ts`). The
 * plaintext is returned to the caller EXACTLY ONCE — at register or rotate — and
 * is never stored, never logged, and never returned by any query.
 *
 *   Public: register, rotateSecret, testConnection
 *
 * All three are `authedAction` (authenticated-member floor); the owner/admin
 * authorization, input validation, and persistence live in the internal
 * functions these actions delegate to, in the caller's propagated session.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { generateConnectedAppSecret, sealConnectedAppSecret } from './secretBox';
import { probeConnectedAppEndpoint, type ConnectedAppConnectionTestResult } from './connectionTest';
import type { PublicConnectedApp } from './model';

/** A sealed envelope ready for an internal mutation, plus the one-time plaintext. */
function mintSealedSecret(): {
	secret: string;
	envelope: {
		secretCiphertext: string;
		secretIv: string;
		secretAuthTag: string;
		secretEnvelopeVersion: number;
	};
} {
	const secret = generateConnectedAppSecret();
	const sealed = sealConnectedAppSecret(secret);
	return {
		secret,
		envelope: {
			secretCiphertext: sealed.ciphertext,
			secretIv: sealed.iv,
			secretAuthTag: sealed.authTag,
			secretEnvelopeVersion: sealed.version,
		},
	};
}

/**
 * Register a connected app: mint + seal a shared secret, then persist the record
 * (owner/admin-gated, input-validated in the internal mutation). Returns the
 * created app plus the plaintext secret — the ONLY time it is ever revealed.
 */
// authz: owner/admin gate + input validation live in the delegated internal
// mutation connectedApps.mutations._insertConnectedApp (requireOrgPermission).
export const register = authedAction({
	args: {
		pluginId: v.string(),
		name: v.string(),
		endpointUrl: v.string(),
		grantedCapabilities: v.array(v.string()),
	},
	handler: async (ctx, args): Promise<PublicConnectedApp & { secret: string }> => {
		const { secret, envelope } = mintSealedSecret();
		const app = await ctx.runMutation(internal.connectedApps.mutations._insertConnectedApp, {
			pluginId: args.pluginId,
			name: args.name,
			endpointUrl: args.endpointUrl,
			grantedCapabilities: args.grantedCapabilities,
			...envelope,
		});
		return { ...app, secret };
	},
});

/**
 * Rotate a connected app's shared secret: mint + seal a new secret and replace
 * the sealed envelope (owner/admin-gated; illegal on a revoked app). Returns the
 * new plaintext secret once. The previous secret is irrecoverable afterward.
 */
// authz: owner/admin gate lives in the delegated internal mutation
// connectedApps.mutations._rotateConnectedAppSecret (requireOrgPermission).
export const rotateSecret = authedAction({
	args: { connectedAppId: v.id('connectedApps') },
	handler: async (ctx, args): Promise<{ connectedAppId: Id<'connectedApps'>; secret: string }> => {
		const { secret, envelope } = mintSealedSecret();
		await ctx.runMutation(internal.connectedApps.mutations._rotateConnectedAppSecret, {
			connectedAppId: args.connectedAppId,
			...envelope,
		});
		return { connectedAppId: args.connectedAppId, secret };
	},
});

/**
 * Test whether a connected app's hook endpoint is reachable. Resolves the
 * tenant-scoped endpoint via an owner/admin-gated internal query, then runs a
 * single SSRF-guarded, deadline-bounded probe (see `connectionTest.ts`). This is
 * NOT a signed hook: it carries no secret and grants the app nothing. A revoked
 * app is refused without any network request — its endpoint is dead. The probe
 * never throws, so the result always fails closed to a clear outcome.
 */
// authz: owner/admin gate lives in the delegated internal query
// connectedApps.queries._loadEndpointForTest (requireOrgPermission).
export const testConnection = authedAction({
	args: { connectedAppId: v.id('connectedApps') },
	handler: async (ctx, args): Promise<ConnectedAppConnectionTestResult> => {
		const target = await ctx.runQuery(internal.connectedApps.queries._loadEndpointForTest, {
			connectedAppId: args.connectedAppId,
		});
		if (target.status === 'revoked') {
			return {
				outcome: 'blocked',
				status: null,
				message: 'This app is revoked. Register a new app to test a fresh connection.',
			};
		}
		return probeConnectedAppEndpoint(target.endpointUrl);
	},
});
