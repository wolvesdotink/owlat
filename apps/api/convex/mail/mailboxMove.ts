/**
 * "Move my mailbox here" — the staged full move of a connected external mailbox
 * onto an Owlat-hosted mailbox on the SAME address (piece c5).
 *
 * A migration (mail/migration.ts) is a one-time HISTORICAL import that leaves
 * the external account live and syncing. A *move* goes the rest of the way: it
 * provisions a hosted mailbox for the same address, guides the user through
 * pointing their domain's inbound MX at this deployment, and finally demotes the
 * old external account to a READ-ONLY ARCHIVE — sync stops, the history stays
 * fully queryable, and NOTHING is deleted.
 *
 * The flow is a small, one-way state machine that is safe to poke at every step:
 *
 *   provisioning ──▶ cutover_pending ──▶ archived
 *
 * Every transition is IDEMPOTENT (re-running the current stage is a no-op) and
 * the whole job is PAUSABLE, so a member can stop between DNS steps and resume
 * later. Fail-soft throughout — each stage surfaces its current truth (the
 * mailbox's last sync, live MX state) rather than assuming success.
 *
 * Hosted-mailbox creation is admin-only, so a non-admin mover can't provision
 * their own hosted mailbox: `start` raises an in-app mailbox request instead
 * (surfaced to admins, never bypassed) and the job waits in `provisioning` until
 * an admin runs `provisionHosted`.
 *
 * Rollback is the `cancel` mutation: the archive demotion is the ONLY
 * irreversible step and it never runs before the final stage, so cancelling a
 * move-in-progress (and repointing MX back at the old provider) loses nothing.
 *
 *   Public:  moveStatus, start, provisionHosted, archive, pause, resume, cancel
 *
 * The live MX check runs in the Node sibling `mailboxMoveActions.ts`.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole, requireAdminContext } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { provisionMailbox } from './mailbox';
import { getOptional } from '../lib/env';
import { throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Standard priority for a single inbound MX host. A deployment with one MTA
 * publishes exactly one MX record; the priority number is only meaningful when
 * several compete, so any value works — 10 is the near-universal convention.
 */
const MX_PRIORITY = 10;

/** The public EHLO/MX hostname mail servers deliver to for this deployment. */
export function inboundMailHost(): string | null {
	return getOptional('EHLO_HOSTNAME')?.trim() || null;
}

type SessionWithRole = NonNullable<Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>>;

/**
 * Resolve the caller's own active external mailbox — the thing a move operates
 * on. Returns `null` when the caller is anonymous/role-less, has no external
 * account, or the account/mailbox isn't in a movable state, letting each caller
 * pick its own failure mode.
 */
async function getCallerExternalMailbox(ctx: QueryCtx | MutationCtx): Promise<{
	session: SessionWithRole;
	account: Doc<'externalMailAccounts'>;
	mailbox: Doc<'mailboxes'>;
} | null> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session || !session.role) return null;
	const account = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', session.userId))
		.first();
	if (!account) return null;
	const mailbox = await ctx.db.get(account.mailboxId);
	if (!mailbox) return null;
	return { session, account, mailbox };
}

/** The caller's own move job, if any (at most one live per user). */
async function getCallerMove(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'mailboxMoves'> | null> {
	return ctx.db
		.query('mailboxMoves')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
}

/**
 * Everything the settings surface needs to render the move flow for the caller's
 * own mailbox: eligibility, the move's current stage/truth, and the exact MX
 * record to hand a DNS admin. Soft-auth — returns `{ eligible: false }` for an
 * anonymous caller or one with no external mailbox to move.
 */
// public: soft-auth — reads only the caller's own external mailbox + move rows.
export const moveStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const mailHost = inboundMailHost();

		const resolved = await getCallerExternalMailbox(ctx);
		if (!resolved) {
			return { eligible: false as const };
		}
		const { session, account, mailbox } = resolved;

		const move = await getCallerMove(ctx, session.userId);
		// Owners/admins can provision a hosted mailbox themselves; anyone else must
		// wait for an admin to act on the request `start` raised.
		const isAdmin = session.role === 'owner' || session.role === 'admin';

		return {
			eligible: true as const,
			address: mailbox.address,
			domain: mailbox.domain,
			// The mover's own last-sync truth (fail-soft: shown as-is, never assumed).
			lastSyncAt: account.lastSyncAt ?? null,
			accountStatus: account.status,
			canProvisionSelf: isAdmin,
			// The MX target + record to publish (null host ⇒ send-only install with
			// no inbound MTA; the UI omits the guidance and the move can't complete).
			mxHost: mailHost,
			mxPriority: MX_PRIORITY,
			move: move
				? {
						id: move._id,
						stage: move.stage,
						paused: move.paused,
						hostedMailboxId: move.hostedMailboxId ?? null,
						awaitingAdminProvision:
							move.stage === 'provisioning' && move.provisionRequestId != null,
						createdAt: move.createdAt,
						updatedAt: move.updatedAt,
						archivedAt: move.archivedAt ?? null,
					}
				: null,
		};
	},
});

/**
 * Begin a move. Idempotent — reuses the caller's existing move for the same
 * account instead of stacking a second one. Creates the job in `provisioning`;
 * when the mover can't create a hosted mailbox themselves (not an admin), also
 * raises an in-app mailbox request so an admin can pick it up. The mailbox stays
 * fully live throughout — nothing about the connected account changes here.
 */
// authz: self — operates on the caller's own external mailbox (by_user).
export const start = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const resolved = await getCallerExternalMailbox(ctx);
		if (!resolved) throwNotFound('External mail account');
		const { session, account, mailbox } = resolved;
		if (!session.activeOrganizationId) throwForbidden('No active organization');

		// Idempotent: one move per external account.
		const existing = await ctx.db
			.query('mailboxMoves')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.first();
		if (existing) {
			return { moveId: existing._id, stage: existing.stage };
		}

		const now = Date.now();
		const isAdmin = session.role === 'owner' || session.role === 'admin';

		// Non-admins can't provision hosted mailboxes — surface a request rather
		// than bypassing the admin-only gate.
		let provisionRequestId: Id<'mailboxRequests'> | undefined;
		if (!isAdmin) {
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
				.first();
			const requesterEmail = profile?.email?.trim() || mailbox.address;
			provisionRequestId = await ctx.db.insert('mailboxRequests', {
				authUserId: session.userId,
				organizationId: session.activeOrganizationId,
				requesterEmail,
				requesterName: profile?.name,
				note: `Move my mailbox here — please provision a hosted mailbox for ${mailbox.address}.`,
				status: 'open',
				createdAt: now,
			});
		}

		const moveId = await ctx.db.insert('mailboxMoves', {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			accountId: account._id,
			sourceMailboxId: mailbox._id,
			address: mailbox.address,
			domain: mailbox.domain,
			stage: 'provisioning',
			paused: false,
			provisionRequestId,
			createdAt: now,
			updatedAt: now,
		});
		return { moveId, stage: 'provisioning' as const };
	},
});

/**
 * Provision the hosted mailbox for a move — the `provisioning → cutover_pending`
 * transition. Admin-only (creating a hosted mailbox is an operator action; the
 * gate is never bypassed). Idempotent: if the hosted mailbox already exists the
 * move is simply returned. The new hosted mailbox is authoritative on the local
 * MTA, so once the domain's MX points here inbound mail lands in it — but until
 * then it sits empty and the external account keeps delivering, so provisioning
 * is safe to do early.
 */
// authz: admin — requireAdminContext gates hosted-mailbox creation.
export const provisionHosted = authedMutation({
	args: { moveId: v.id('mailboxMoves') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const session = await requireAdminContext(ctx);

		const move = await ctx.db.get(args.moveId);
		if (!move) throwNotFound('Mailbox move');
		if (move.organizationId !== session.activeOrganizationId) {
			throwForbidden('Move not accessible');
		}

		// Idempotent: already provisioned (or further along) → no-op.
		if (move.hostedMailboxId != null) {
			return { hostedMailboxId: move.hostedMailboxId, stage: move.stage };
		}
		if (move.stage !== 'provisioning') {
			throwInvalidState('This move is past provisioning');
		}

		const now = Date.now();
		// Deliberately bypass the address dup-check: the external mailbox already
		// holds this address. The move intentionally stands up a second, hosted
		// mailbox for it — it becomes the live inbox once MX cuts over and the
		// external one is archived. The external mailbox is kind='external' (never
		// pushed to the MTA cache), so only the hosted mailbox claims the address
		// on the MTA — no routing ambiguity.
		const hostedMailboxId = await provisionMailbox(ctx, {
			userId: move.userId,
			organizationId: move.organizationId,
			address: move.address,
			domain: move.domain,
			displayName: undefined,
			kind: 'hosted',
			scope: 'personal',
		});

		await ctx.db.patch(move._id, {
			hostedMailboxId,
			stage: 'cutover_pending',
			updatedAt: now,
		});

		// Resolve the request that surfaced this to admins, if any.
		if (move.provisionRequestId != null) {
			const request = await ctx.db.get(move.provisionRequestId);
			if (request && request.status === 'open') {
				await ctx.db.patch(move.provisionRequestId, {
					status: 'resolved',
					resolvedByUserId: session.userId,
					resolvedAt: now,
				});
			}
		}

		await ctx.db.insert('mailAuditLog', {
			mailboxId: hostedMailboxId,
			event: 'mailbox_move.hosted_provisioned',
			occurredAt: now,
		});

		return { hostedMailboxId, stage: 'cutover_pending' as const };
	},
});

/**
 * Complete the move — the `cutover_pending → archived` transition. Demotes the
 * old external account to a READ-ONLY ARCHIVE: sync stops (the worker skips
 * `disconnected` accounts) but the archive mailbox stays `active` so its history
 * remains fully queryable, and nothing is deleted. Idempotent: an already
 * archived move is a no-op. Refused before a hosted mailbox exists (provision
 * first). Self — the mover archives their own move.
 */
// authz: self — archives only the caller's own move.
export const archive = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !session.role) throwForbidden('Not authenticated');

		const move = await getCallerMove(ctx, session.userId);
		if (!move) throwNotFound('Mailbox move');

		// Idempotent terminal state.
		if (move.stage === 'archived') {
			return { stage: 'archived' as const };
		}
		if (move.stage !== 'cutover_pending') {
			throwInvalidState('Provision a hosted mailbox before archiving the old one');
		}

		const now = Date.now();
		const account = await ctx.db.get(move.accountId);
		if (account && account.status !== 'disconnected') {
			// Stop the mail-sync worker: it only picks up pending/connected/error
			// accounts, so flipping to 'disconnected' halts sync. The mailbox row is
			// left 'active' (unlike the hard disconnect path) so the archived history
			// stays readable — a read-only archive, not a deleted mailbox.
			await ctx.db.patch(account._id, { status: 'disconnected', updatedAt: now });
			await ctx.db.insert('mailAuditLog', {
				mailboxId: move.sourceMailboxId,
				event: 'mailbox_move.archived',
				occurredAt: now,
			});
		}

		await ctx.db.patch(move._id, {
			stage: 'archived',
			paused: false,
			archivedAt: now,
			updatedAt: now,
		});
		return { stage: 'archived' as const };
	},
});

/** Pause the move (fail-soft resume point). No-op once archived. Self. */
// authz: self — pauses only the caller's own move.
export const pause = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !session.role) throwForbidden('Not authenticated');
		const move = await getCallerMove(ctx, session.userId);
		if (!move) throwNotFound('Mailbox move');
		if (move.stage === 'archived' || move.paused) {
			return { paused: move.paused };
		}
		await ctx.db.patch(move._id, { paused: true, updatedAt: Date.now() });
		return { paused: true };
	},
});

/** Resume a paused move. Idempotent. Self. */
// authz: self — resumes only the caller's own move.
export const resume = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !session.role) throwForbidden('Not authenticated');
		const move = await getCallerMove(ctx, session.userId);
		if (!move) throwNotFound('Mailbox move');
		if (!move.paused) {
			return { paused: false };
		}
		await ctx.db.patch(move._id, { paused: false, updatedAt: Date.now() });
		return { paused: false };
	},
});

/**
 * Cancel a move-in-progress — the documented rollback. Refused once `archived`
 * (that's terminal; the "undo the archive" is a separate flow). If a hosted
 * mailbox was already provisioned it's soft-deleted and pulled from the MTA
 * cache, so inbound routing falls back to the external provider once MX is
 * repointed — nothing is lost. The external account is untouched (still live and
 * syncing). Self.
 */
// authz: self — cancels only the caller's own move.
export const cancel = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !session.role) throwForbidden('Not authenticated');
		const move = await getCallerMove(ctx, session.userId);
		if (!move) throwNotFound('Mailbox move');
		if (move.stage === 'archived') {
			throwInvalidState("This move is already complete and can't be cancelled");
		}

		const now = Date.now();

		// Tear down the hosted mailbox we stood up (it holds no real mail yet — MX
		// never cut over — so soft-delete + un-cache is a clean rollback).
		if (move.hostedMailboxId != null) {
			const hosted = await ctx.db.get(move.hostedMailboxId);
			if (hosted && hosted.status !== 'deleted') {
				await ctx.db.patch(move.hostedMailboxId, { status: 'deleted', updatedAt: now });
				await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.removeFromCache, {
					address: hosted.address,
				});
			}
		}

		// Withdraw the admin request if it's still open.
		if (move.provisionRequestId != null) {
			const request = await ctx.db.get(move.provisionRequestId);
			if (request && request.status === 'open') {
				await ctx.db.patch(move.provisionRequestId, {
					status: 'resolved',
					resolvedByUserId: session.userId,
					resolvedAt: now,
				});
			}
		}

		await ctx.db.delete(move._id);
		return { cancelled: true as const };
	},
});
