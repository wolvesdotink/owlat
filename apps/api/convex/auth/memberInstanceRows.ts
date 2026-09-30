/**
 * The part of a member's erasure that the workspace deletion's sweep does not
 * cover: rows keyed by the member's user id in tables outside the workspace
 * (the onboarding checklist, its send-ready notices, the platform-admin grant),
 * plus closing the account-deletion request.
 *
 * Split out of `memberErasure.ts` because that job runs it in two situations:
 * as one step of the full member erasure, and on its own when the member's
 * erasure runs during a workspace deletion, whose sweep erases the rest.
 */

import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

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

export async function completeDeletionRequest(
	ctx: MutationCtx,
	requestId: Id<'accountDeletionRequests'>
): Promise<void> {
	const request = await ctx.db.get(requestId);
	if (request && request.status !== 'completed') {
		await ctx.db.patch(requestId, { status: 'completed', statusChangedAt: Date.now() });
	}
}
