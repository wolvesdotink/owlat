'use node';

/**
 * Previous-release paths of `aiRouting/providerConfigActions.ts`. The AI
 * provider settings page in a tab opened before the deploy still saves, tests
 * and lists models through `aiProviderConfigActions:*` by path, and a previous
 * release's resolver still running when this one deploys decrypts a stored key
 * through `_decryptSecretEnvelope`. Each function keeps its old path, builder,
 * auth floor, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { anchorActionDeadline } from './lib/llm/actionDeadline';
import { authedAction } from './lib/authedFunctions';
import {
	decryptEnvelope,
	envelopeArgs,
	listProviderModels,
	planeValidator,
	saveConfigArgs,
	saveProviderConfig,
	testProviderConnection,
} from './aiRouting/providerConfigActions';

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfigActions:saveConfig`. */
// authz: admin gate is enforced in the delegated internal mutation
// `aiRouting/providerConfig._persistConfig` (requireOrgPermission
// 'organization:manage'), which also records the audit log — actions can't read
// ctx.db to gate here.
export const saveConfig = authedAction({
	args: saveConfigArgs,
	handler: async (ctx, args): Promise<Id<'aiProviderConfig'>> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await saveProviderConfig(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfigActions:testConnection`. */
// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin inside the shared body, as on the moved function.
export const testConnection = authedAction({
	args: { plane: planeValidator },
	handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await testProviderConnection(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfigActions:listModels`. */
// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin inside the shared body, as on the moved function.
export const listModels = authedAction({
	args: { plane: planeValidator },
	handler: async (ctx, args): Promise<{ supported: boolean; models: string[]; error?: string }> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await listProviderModels(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfigActions:_decryptSecretEnvelope`. */
export const _decryptSecretEnvelope = internalAction({
	args: envelopeArgs,
	returns: v.string(),
	handler: async (_ctx, args): Promise<string> => decryptEnvelope(args),
});
