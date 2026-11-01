/**
 * Previous-release paths of `aiRouting/providerConfig.ts`. The AI provider
 * settings page in a tab opened before the deploy still reads and removes the
 * config through `aiProviderConfig:*` by path, and a previous release's save,
 * connection test, model listing or resolver still running when this one
 * deploys calls the internal functions by their old paths. Each function keeps
 * its old path, builder, auth floor, arguments and result shape, and runs the
 * same body as its replacement. Remove after release 0.6.17.
 */

import { internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalMutation } from './lib/writeFence';
import { adminMutation, authedQuery } from './lib/authedFunctions';
import {
	persistConfigArgs,
	persistProviderConfig,
	readConfigRow,
	readProviderConfig,
	removeProviderConfig,
} from './aiRouting/providerConfig';

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfig:getConfig`. */
// all-members: read-only provider/model selections + masked previews only (no
// secret ever leaves the backend), so any org member may read the config.
export const getConfig = authedQuery({
	args: {},
	handler: async (ctx) => await readProviderConfig(ctx),
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfig:_persistConfig`. */
export const _persistConfig = internalMutation({
	args: persistConfigArgs,
	handler: async (ctx, args): Promise<Id<'aiProviderConfig'>> =>
		await persistProviderConfig(ctx, args),
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfig:_getConfigRow`. */
export const _getConfigRow = internalQuery({
	args: {},
	handler: async (ctx) => await readConfigRow(ctx),
});

/** Remove after release 0.6.17; this release calls `aiRouting/providerConfig:removeConfig`. */
export const removeConfig = adminMutation({
	args: {},
	handler: async (ctx, _args, session): Promise<{ removed: boolean }> =>
		await removeProviderConfig(ctx, session.userId),
});
