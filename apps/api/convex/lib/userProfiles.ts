/**
 * `userProfiles` lookups keyed by BetterAuth user id, and the one rule for
 * "is this user a live member of the organization".
 *
 * Single org per deployment: a `userProfiles` row IS org membership. A row with
 * `deletedAt` set belongs to a user whose account is being deleted; it stays
 * until the retention cron hard-deletes it (see `schema/auth.ts`), and during
 * that window the user must not be added to team inboxes, chat rooms or DMs,
 * nor be assigned threads. {@link loadLiveUserProfile} is the only place that
 * rule lives; every membership-write floor goes through it.
 *
 * Display lookups ({@link loadProfileSummary}) deliberately do NOT apply the
 * rule: a deleted user's past messages and roster rows keep their name until
 * the profile row is gone.
 *
 * This module does not import `lib/sessionOrganization.ts` (whose
 * `loadOwnUserProfile` is the same raw lookup): many tests replace that module
 * wholesale with `vi.mock`, and the membership floors must keep working there.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';

type ProfileReadCtx = QueryCtx | MutationCtx;

async function loadUserProfileRow(
	ctx: ProfileReadCtx,
	authUserId: string
): Promise<Doc<'userProfiles'> | null> {
	return ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
}

/**
 * The user's `userProfiles` row, or `null` when there is none or it is
 * soft-deleted (`deletedAt` set).
 */
export async function loadLiveUserProfile(
	ctx: ProfileReadCtx,
	authUserId: string
): Promise<Doc<'userProfiles'> | null> {
	const row = await loadUserProfileRow(ctx, authUserId);
	return row && row.deletedAt === undefined ? row : null;
}

/** Whether `authUserId` is a live (existing, not soft-deleted) org member. */
export async function isLiveOrgMember(ctx: ProfileReadCtx, authUserId: string): Promise<boolean> {
	return (await loadLiveUserProfile(ctx, authUserId)) !== null;
}

/**
 * Assert every id in `authUserIds` is a live org member. Membership-write
 * mutations take free-form user-id strings; this floor keeps bogus, foreign and
 * soft-deleted ids out. Ids are deduped first. With `max` set, a batch larger
 * than `max` (before dedupe) throws `tooManyMessage` (or a generic message).
 * The first non-live id throws `message` as invalid input.
 */
export async function assertLiveOrgMembers(
	ctx: ProfileReadCtx,
	authUserIds: readonly string[],
	options: { max?: number; message: string; tooManyMessage?: string }
): Promise<void> {
	if (options.max !== undefined && authUserIds.length > options.max) {
		throwInvalidInput(
			options.tooManyMessage ?? `Cannot add more than ${options.max} people at once`
		);
	}
	for (const id of new Set(authUserIds)) {
		if (!(await isLiveOrgMember(ctx, id))) {
			throwInvalidInput(options.message);
		}
	}
}

/**
 * Display fields of a user's `userProfiles` row. All fields are `null` when the
 * row is missing (for example the reserved assistant author id).
 */
export type ProfileSummary = {
	name: string | null;
	email: string | null;
	image: string | null;
};

/** Load the `{ name, email, image }` display summary for a user. */
export async function loadProfileSummary(
	ctx: ProfileReadCtx,
	authUserId: string
): Promise<ProfileSummary> {
	const row = await loadUserProfileRow(ctx, authUserId);
	return {
		name: row?.name ?? null,
		email: row?.email ?? null,
		image: row?.image ?? null,
	};
}
