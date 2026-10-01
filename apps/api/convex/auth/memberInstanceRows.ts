/**
 * The part of a member's erasure that no workspace deletion sweeps: rows keyed
 * by the member's user id in tables outside the workspace (the onboarding
 * checklist, its send-ready notices, the platform-admin grant).
 *
 * One step of the persisted member erasure (`auth/erasure/memberPhases.ts`),
 * which runs it even while a workspace deletion is sweeping everything else.
 */

import type { MutationCtx } from '../_generated/server';

export async function deleteMemberInstanceRows(
	ctx: MutationCtx,
	authUserId: string
): Promise<void> {
	// Per-user onboarding checklist row (keyed by authUserId).
	const onboarding = await ctx.db
		.query('userOnboarding')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first(); // bounded: at most one row per user
	if (onboarding) await ctx.db.delete(onboarding._id);

	// Their "you can send now" onboarding notices go with that checklist —
	// without the row they point at, they are orphaned nudges nobody reads.
	const sendReadyNotices = await ctx.db
		.query('sendReadyNotices')
		.withIndex('by_user_and_created', (q) => q.eq('userId', authUserId))
		.collect(); // bounded: at most one pending notice per readiness edge
	for (const notice of sendReadyNotices) await ctx.db.delete(notice._id);

	// Platform-admin grant. This is deployment-level power (in-app updates,
	// backups, the operator console) keyed by BetterAuth user id, so leaving
	// the row behind would mean a departed member's id still satisfies
	// `requirePlatformAdmin` — and the id is reusable ground for whoever
	// claims that identity next. It also carries their email, which this
	// erasure is meant to remove.
	const platformAdminRows = await ctx.db
		.query('platformAdmins')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.collect(); // bounded: at most one row per user
	for (const row of platformAdminRows) await ctx.db.delete(row._id);
}
