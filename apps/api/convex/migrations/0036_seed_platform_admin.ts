/**
 * One-shot platform-admin bootstrap.
 *
 * This is deliberately hand-run: OSS self-hosts have no production control
 * plane that grants instance-wide operator power. An operator who chooses to
 * enable that surface invokes
 * `convex run migrations/0036_seed_platform_admin:run '{...}'` once.
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
