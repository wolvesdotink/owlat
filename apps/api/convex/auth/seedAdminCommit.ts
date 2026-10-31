/**
 * The one commit of `POST /seed/admin` (`seedAdminHttp.ts`): the first admin's
 * BetterAuth user, credential account, organization and owner membership, the
 * user profile, the instance settings row with its one-shot latch, the initial
 * platform-admin grant and the wizard's feature flags, in one transaction. A
 * seed that fails anywhere writes nothing, so the instance is either fully
 * seeded and latched or untouched and still seedable.
 */

import { v } from 'convex/values';
import { components, internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { betterAuthAdapterArgs } from '../lib/betterAuthAdapterArgs';
import { logError } from '../lib/runtimeLog';
import { claimAdminSeed } from '../workspaces/settings';
import { writeAllFlags } from '../workspaces/featureFlags';
import { ensureUserProfile } from './userProfiles';
import type { AdminSeedOutcome } from './seedAdminDecision';

export const commitAdminSeed = internalMutation({
	args: {
		email: v.string(),
		name: v.string(),
		passwordHash: v.string(),
		orgName: v.string(),
		orgSlug: v.string(),
		isMigrationMode: v.boolean(),
		flags: v.optional(v.record(v.string(), v.boolean())),
	},
	handler: async (ctx, args): Promise<AdminSeedOutcome> => {
		// The route's probes ran in their own transactions; these two are the
		// authoritative one-shot checks, atomic with the writes below.
		const existingUser = await ctx.runQuery(components.betterAuth.adapter.findMany, {
			model: 'user',
			where: [],
			paginationOpts: { cursor: null, numItems: 1 },
		});
		if (existingUser?.page && existingUser.page.length > 0) return { outcome: 'users_exist' };
		const { claimed } = await claimAdminSeed(ctx, {
			timezone: 'UTC',
			defaultFromName: args.orgName,
			isMigrationMode: args.isMigrationMode,
		});
		if (!claimed) return { outcome: 'already_seeded' };

		const now = Date.now();
		// The adapter GENERATES the row id and its `create` validator rejects a
		// client-supplied `id`. The returned `_id` is the user id every foreign
		// key uses: it is the id BetterAuth resolves at login (the adapter
		// derives the better-auth id from `_id`; see getDocId in
		// @convex-dev/better-auth).
		const userDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'user',
				data: {
					email: args.email,
					name: args.name,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			}),
		})) as unknown as { _id: string };
		const userId = userDoc._id;
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'account',
				data: {
					userId,
					providerId: 'credential',
					accountId: userId,
					password: args.passwordHash,
					createdAt: now,
					updatedAt: now,
				},
			}),
		});
		const orgDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'organization',
				data: { name: args.orgName, slug: args.orgSlug, createdAt: now },
			}),
		})) as unknown as { _id: string };
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'member',
				data: { userId, organizationId: orgDoc._id, role: 'owner', createdAt: now },
			}),
		});
		await ensureUserProfile(ctx, { authUserId: userId, email: args.email, name: args.name });

		// On a single-org self-host the person who ran setup owns both the org and
		// the box, so they get the operator surface (System & Updates, Backups,
		// Operator) too. Best-effort, in a sub-transaction: a failed grant rolls
		// back only its own writes, and the owner can still claim the empty
		// roster from the admin hub (`claimInitialPlatformAdmin`).
		try {
			await ctx.runMutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});
		} catch (error) {
			logError('[seedAdmin] platform-admin grant failed (instance is still usable):', error);
		}

		if (args.flags) await writeAllFlags(ctx, args.flags);
		return { outcome: 'seeded', userId };
	},
});
