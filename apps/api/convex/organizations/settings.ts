/**
 * Organization settings (module) — sole writer of the singleton
 * `instanceSettings` row's *settings columns* (`emailTheme`, `timezone`,
 * `defaultFromName`, `defaultFromEmail`, `updatedAt`). Sibling of
 * **Feature flags (module)** (which owns the `featureFlags` map),
 * **Abuse status (module)** (which owns the abuse-status columns), and
 * the **Organization deletion (module)** walker scheduled by `remove`.
 *
 * Four entry points:
 *   - `get`              — read the singleton row (auth-gated).
 *   - `update`           — patch the settings columns; requires
 *                         `settings:manage` (owner/admin). Unifies the
 *                         pre-deepening drift where any signed-in member
 *                         could write these fields.
 *   - `remove`           — schedules the **Organization deletion**
 *                         walker; owner-only.
 *   - `createInternal`   — idempotent bootstrap insert (called by
 *                         `seedAdmin.ts`).
 *
 * See docs/adr/0026-organization-settings-modules.md.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import {
	getUserIdFromSession,
	getMutationContext,
	requirePermission,
	requireOrgPermission,
} from '../lib/sessionOrganization';

export const get = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);
		return await ctx.db.query('instanceSettings').first();
	},
});

export const update = authedMutation({
	args: {
		timezone: v.optional(v.string()),
		defaultFromName: v.optional(v.string()),
		defaultFromEmail: v.optional(v.string()),
		emailTheme: v.optional(
			v.object({
				primaryColor: v.string(),
				fontFamily: v.string(),
				backgroundColor: v.string(),
				baseWidth: v.optional(v.number()),
			})
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'settings:manage', 'Only owners and admins can update organization settings');
		const now = Date.now();
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) {
			await ctx.db.patch(existing._id, { ...args, updatedAt: now });
			return existing._id;
		}
		return await ctx.db.insert('instanceSettings', {
			...args,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const remove = authedMutation({
	args: {},
	handler: async (ctx) => {
		const session = await getMutationContext(ctx);
		requirePermission(
			session.role === 'owner',
			'Only the owner can delete the organization'
		);
		await ctx.scheduler.runAfter(
			0,
			internal.organizations.deletion.walker.start,
			{},
		);
		return { success: true, message: 'Organization deletion started' };
	},
});

export const createInternal = internalMutation({
	args: {
		timezone: v.optional(v.string()),
		defaultFromName: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) return existing._id;
		const now = Date.now();
		return await ctx.db.insert('instanceSettings', {
			timezone: args.timezone || 'UTC',
			defaultFromName: args.defaultFromName,
			createdAt: now,
		});
	},
});
