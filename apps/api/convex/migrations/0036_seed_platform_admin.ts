/**
 * One-shot platform-admin bootstrap — the break-glass path.
 *
 * Normal installs no longer need this: `/seed/admin` grants the setup user the
 * first `superadmin` row, and an instance seeded before that shipped is claimed
 * by its org owner from the admin hub (`platformAdmin/bootstrap.ts`). What is
 * left for this migration is recovery — an instance whose last superadmin was
 * removed, or one where the owner account itself is gone, so no in-app caller
 * can satisfy either bootstrap path. An operator with shell access then runs
 * `convex run migrations/0036_seed_platform_admin:run '{...}'` once.
 *
 * Like the in-app paths, it only succeeds while the table is empty.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

export const run = internalMutation({
	args: {
		authUserId: v.string(),
		email: v.string(),
	},
	handler: async (ctx, args) => {
		const existingAdmin = await ctx.db.query('platformAdmins').first();
		if (existingAdmin) {
			throw new Error('Platform admins already exist. Use platformAdminMutations to add more.');
		}

		return await ctx.db.insert('platformAdmins', {
			authUserId: args.authUserId,
			email: args.email,
			role: 'superadmin',
			createdAt: Date.now(),
		});
	},
});
