/**
 * Seed loader: accounts — dummy teammate sign-ins for local dev.
 *
 * Creates BetterAuth user + credential account + org member rows via the
 * component adapter (the same direct-adapter path `seedAdmin.ts` uses; the
 * public signup flow is closed because this deployment enforces the
 * single-org invariant), plus the matching `userProfiles` row.
 *
 * Passwords: mutations can't run scrypt, so each fixture record carries a
 * precomputed BetterAuth-compatible hash (`{salt-hex}:{key-hex}`, see
 * `@owlat/shared/passwordHash`) with the plaintext documented right next to
 * it. These are throwaway dev credentials — the whole endpoint is gated on
 * `OWLAT_DEV_MODE`.
 *
 * Requires an existing organization (created by `POST /seed/admin` /
 * `bootstrap-org`). Without one, every record is skipped — `bun run dev:seed`
 * orders the admin bootstrap first.
 *
 * NOT wiped by `?reset=true`: the rows live in the BetterAuth component, out
 * of reach of the seed-tag sweep. Reseeding skips existing emails instead;
 * `POST /dev/reset` wipes them along with everything else.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { components } from '../../_generated/api';
import type { LoadResult, Loader } from './types';

interface AccountFixture {
	slug: string;
	email: string;
	name: string;
	role: 'admin' | 'member';
	/** Documentation only — the plaintext behind `passwordHash`. */
	password: string;
	passwordHash: string;
}

type AdapterArgs = Parameters<MutationCtx['runMutation']>[1];

async function findOne(
	ctx: MutationCtx,
	model: string,
	where: Array<{ field: string; value: string }>
): Promise<{ _id: string } | null> {
	const result: { page: Array<{ _id: string }> } = await ctx.runQuery(
		components.betterAuth.adapter.findMany,
		{
			model,
			where,
			paginationOpts: { cursor: null, numItems: 1 },
		} as unknown as AdapterArgs
	);
	return result?.page?.[0] ?? null;
}

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as AccountFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'userProfiles'>> = {};
	const now = Date.now();

	// Teammates join the singleton org; without one there is nothing to join.
	const org = await findOne(ctx, 'organization', []);
	if (!org) {
		return { inserted: 0, skipped: records.length, ids };
	}
	const orgId = String(org._id);

	for (const rec of records) {
		const existing = await findOne(ctx, 'user', [{ field: 'email', value: rec.email }]);
		if (existing) {
			skipped++;
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', String(existing._id)))
				.first();
			if (profile) ids[rec.slug] = profile._id;
			continue;
		}

		const userDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'user',
				data: {
					email: rec.email,
					name: rec.name,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			},
		} as unknown as AdapterArgs)) as unknown as { _id: string };
		const userId = String(userDoc._id);

		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'account',
				data: {
					userId,
					providerId: 'credential',
					accountId: userId,
					password: rec.passwordHash,
					createdAt: now,
					updatedAt: now,
				},
			},
		} as unknown as AdapterArgs);

		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: {
					userId,
					organizationId: orgId,
					role: rec.role,
					createdAt: now,
				},
			},
		} as unknown as AdapterArgs);

		ids[rec.slug] = await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email: rec.email,
			name: rec.name,
			createdAt: now,
			updatedAt: now,
		});
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const accountsLoader: Loader = {
	module: 'accounts',
	dependencies: [],
	load,
};
