import { internalMutation } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedQuery, ownerMutation } from '../lib/authedFunctions';
import { throwInvalidState, throwNotFound } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';

/**
 * How the `platformAdmins` roster comes into existence on a self-hosted
 * instance.
 *
 * Owlat is single-org-per-deployment: the person who runs the setup wizard owns
 * the org AND owns the box the org runs on. Keeping the operator surface
 * (System & Updates, Backups, the Operator console) behind a roster that no
 * production path ever wrote meant a fresh install shipped those pages to
 * NOBODY — the owner deep-linking `/dashboard/admin/system` was bounced to
 * `/dashboard`, and the only way in was a hand-run `convex run` against the
 * container. That is the wrong default for a product whose whole premise is
 * "you run it yourself".
 *
 * Two in-app entry points, both one-shot and both refusing once a roster
 * exists:
 *
 *   - `seedInitialPlatformAdmin` — internal, called by the `/seed/admin` HTTP
 *     action right after it creates the first user. Covers every FRESH install
 *     (setup wizard, `owlat setup` CLI bootstrap-org, `bun run dev:seed`).
 *   - `claimInitialPlatformAdmin` — `ownerMutation`, called from the admin hub
 *     by the org owner. Covers installs that were seeded BEFORE this existed,
 *     without asking the operator to shell into the box.
 *
 * Both grant `superadmin`, which is the role that can manage the roster
 * (`addPlatformAdmin` / `removePlatformAdmin` in `mutations.ts`) — so the setup
 * user can promote colleagues from the UI afterwards.
 *
 * The shell-only recovery path, `migrations/0036_seed_platform_admin`, is the
 * third writer. All three go through `grantInitialSuperadmin`, so each grant is
 * audited the same way and differs only in its `via`.
 *
 * Past the first grant the roster is normal privileged state: the empty-table
 * precondition is what keeps either path from being an escalation vector, and a
 * second caller always gets a refusal rather than a second superadmin.
 */

/** True when no platform admin exists yet — the precondition every path shares. */
async function rosterIsEmpty(ctx: Pick<QueryCtx, 'db'>): Promise<boolean> {
	const existing = await ctx.db.query('platformAdmins').first();
	return existing === null;
}

/** Which bootstrap path granted the first superadmin, recorded in the audit row. */
export type BootstrapVia = 'setup' | 'owner_claim' | 'break_glass';

/**
 * Grant `profile` the first `superadmin` row and audit it as
 * `platform_admin.bootstrap_granted` (resourceId = the new row's id).
 *
 * Returns null, writing nothing, when the roster is not empty; the caller
 * decides whether that is a quiet no-op or a refusal. `auditActor` defaults to
 * the grantee; the owner claim passes its session so the row carries the org.
 */
export async function grantInitialSuperadmin(
	ctx: MutationCtx,
	profile: { authUserId: string; email: string },
	via: BootstrapVia,
	auditActor: { userId: string; organizationId?: string } = { userId: profile.authUserId }
): Promise<Id<'platformAdmins'> | null> {
	if (!(await rosterIsEmpty(ctx))) return null;

	const adminId = await ctx.db.insert('platformAdmins', {
		authUserId: profile.authUserId,
		email: profile.email,
		role: 'superadmin',
		createdAt: Date.now(),
	});

	await recordAuditLog(ctx, {
		userId: auditActor.userId,
		organizationId: auditActor.organizationId,
		action: 'platform_admin.bootstrap_granted',
		resource: 'platform_admin',
		resourceId: adminId,
		details: { email: profile.email, role: 'superadmin', via },
	});

	return adminId;
}

/**
 * Grant the freshly-seeded setup user the initial `superadmin` row.
 *
 * Idempotent and self-guarding: a non-empty roster, or a missing user profile,
 * returns `{ granted: false }` instead of throwing. It is called from inside
 * the `/seed/admin` success path, and a failure to hand out operator tooling
 * must never roll back an otherwise-complete instance bootstrap — the owner can
 * still claim the roster from the UI afterwards.
 */
export const seedInitialPlatformAdmin = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ granted: boolean }> => {
		if (!(await rosterIsEmpty(ctx))) return { granted: false };

		// The seed action creates exactly one profile before calling this, so
		// "the only profile" is the setup user. Resolving it here (rather than
		// taking an authUserId argument) keeps the grant tied to what actually
		// landed in the database.
		const profiles = await ctx.db.query('userProfiles').collect(); // bounded: freshly-seeded instance holds exactly one profile
		const profile = profiles[0];
		if (!profile || profiles.length !== 1) return { granted: false };

		const adminId = await grantInitialSuperadmin(ctx, profile, 'setup');
		return { granted: adminId !== null };
	},
});

/**
 * Let the org owner claim the empty roster for themselves.
 *
 * `ownerMutation` is the floor (owner only — not admins), and the empty-roster
 * check is the authorization: once anybody holds platform admin, promotion runs
 * through `addPlatformAdmin` and a superadmin's judgement instead.
 */
export const claimInitialPlatformAdmin = ownerMutation({
	args: {},
	handler: async (ctx, _args, session): Promise<{ success: true }> => {
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();
		if (!profile) {
			throwNotFound('User');
		}

		const adminId = await grantInitialSuperadmin(ctx, profile, 'owner_claim', {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
		});
		if (adminId === null) {
			throwInvalidState(
				'This instance already has a platform admin. Ask them to add you from Operator → Admins.'
			);
		}

		return { success: true };
	},
});

/**
 * Should the admin hub offer the claim above?
 *
 * Deliberately readable by any org admin, not just platform admins — its whole
 * job is to answer a question the caller cannot yet ask from inside the
 * operator surface. It discloses only whether the roster is empty, never who is
 * on it.
 */
export const getBootstrapStatus = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// all-members: two booleans about the CALLER's own options — whether the
		// roster is empty, and whether their role lets them claim it. No identity,
		// no count, nothing an editor could not infer from the empty admin hub.
		const rosterEmpty = await rosterIsEmpty(ctx);
		// A display decision, not an authorization one — `claimInitialPlatformAdmin`
		// re-derives the owner floor from the session it runs under.
		return { rosterEmpty, canClaim: rosterEmpty && session.role === 'owner' };
	},
});
