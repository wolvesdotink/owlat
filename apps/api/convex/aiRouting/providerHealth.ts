/**
 * The functions behind the record of a refused AI provider key
 * (`lib/providerAuthFailure.ts`): the interpretation run notes a refusal and
 * an accepted call, and admins read it for the notice in AI settings and the
 * app shell.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { adminQuery } from '../lib/authedFunctions';
import {
	clearProviderAuthFailure,
	readProviderAuthFailure,
	recordProviderAuthFailure,
} from '../lib/providerAuthFailure';

export const noteAuthFailure = internalMutation({
	args: {},
	handler: async (ctx) => recordProviderAuthFailure(ctx, Date.now()),
});

export const noteAuthAccepted = internalMutation({
	args: {},
	handler: async (ctx) => clearProviderAuthFailure(ctx),
});

/** For the admin notice in AI settings and the app shell. */
export const getAuthFailure = adminQuery({
	args: {},
	returns: v.union(v.object({ firstSeenAt: v.number(), lastSeenAt: v.number() }), v.null()),
	handler: async (ctx) => readProviderAuthFailure(ctx.db),
});
