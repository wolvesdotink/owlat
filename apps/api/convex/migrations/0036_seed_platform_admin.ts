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
 * Like the in-app paths, it only succeeds while the table is empty, and it
 * writes the same `platform_admin.bootstrap_granted` audit row (via
 * `break_glass`) through `grantInitialSuperadmin`.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { throwInvalidState } from '../_utils/errors';
import { grantInitialSuperadmin } from '../platformAdmin/bootstrap';

export const run = internalMutation({
	args: {
		authUserId: v.string(),
		email: v.string(),
	},
	handler: async (ctx, args) => {
		const adminId = await grantInitialSuperadmin(
			ctx,
			{ authUserId: args.authUserId, email: args.email },
			'break_glass'
		);
		if (adminId === null) {
			throwInvalidState(
				'Platform admins already exist. A superadmin can add more with platformAdmin/mutations:addPlatformAdmin.'
			);
		}
		return adminId;
	},
});
