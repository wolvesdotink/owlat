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
import { authedMutation, adminMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole, hasPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { provisionMailbox } from './mailbox';
import { getOptional } from '../lib/env';
import {
	throwForbidden,
	throwInvalidState,
	throwNotFound,
	throwUnauthenticated,
} from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Standard priority for a single inbound MX host. A deployment with one MTA
 * publishes exactly one MX record; the priority number is only meaningful when
 * several compete, so any value works — 10 is the near-universal convention.
 */
const MX_PRIORITY = 10;

/** The public EHLO/MX hostname mail servers deliver to for this deployment. */
function inboundMailHost(): string | null {
	return getOptional('EHLO_HOSTNAME')?.trim() || null;
}

type SessionWithRole = NonNullable<Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>>;
/** A session narrowed to a real org member — `role` is guaranteed non-null. */
type MoverSession = SessionWithRole & { role: NonNullable<SessionWithRole['role']> };

/**
 * Resolve the caller's own movable external mailbox — the thing a move operates
 * on. Returns `null` when the caller is anonymous/role-less, has no external
 * account, or the account/mailbox isn't in a movable state: a `disconnected`
 * account (whose mailbox was demoted) or a non-`active` mailbox has nothing to
 * move. Mirrors `externalAccounts.getForCurrentUser`. Each caller picks its own
 * failure mode from the `null`.
 */
async function getCallerExternalMailbox(ctx: QueryCtx | MutationCtx): Promise<{
	session: MoverSession;
	account: Doc<'externalMailAccounts'>;
	mailbox: Doc<'mailboxes'>;
} | null> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session || !session.role) return null;
	const account = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', session.userId))
		.first();
	// A disconnected account is dead (its mailbox was set to 'deleted' on
	// disconnect) — there's nothing live to move.
	if (!account || account.status === 'disconnected') return null;
	const mailbox = await ctx.db.get(account.mailboxId);
	if (!mailbox || mailbox.status !== 'active') return null;
	return { session: session as MoverSession, account, mailbox };
}

/**
 * The move belonging to a specific external account — the correct pairing when
 * the caller has a live account. A move row is keyed to the account it operates
 * on (`by_account`), so this returns the move for exactly *this* mailbox, never
 * a stale archived move left by a different (earlier) account.
 */
async function getMoveForAccount(
	ctx: QueryCtx | MutationCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<Doc<'mailboxMoves'> | null> {
	return ctx.db
		.query('mailboxMoves')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.first();
}

/**
 * The caller's newest move row, used ONLY to surface the terminal (archived)
 * truth when no live external account remains. `.order('desc')` picks the most
 * recent move so a stale terminal row can't shadow a newer one; a move for a
 * still-live account is paired via `getMoveForAccount` instead.
 */
async function getLatestCallerMove(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'mailboxMoves'> | null> {
	return ctx.db
		.query('mailboxMoves')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.order('desc')
		.first();
}

/**
 * Shared preamble for the self-scoped move mutations (archive/pause/resume/
 * cancel): require an authenticated org member and load their own move, or
 * throw. Folds the repeated auth + not-found block into one call.
 *
 * Pairs the move with the account it belongs to: when the caller still has a
 * live external account, the move is loaded `by_account` on that account — so a
 * terminal move left by an *earlier* account never shadows a fresh one. Only
 * when no live account remains (a completed move demoted it to `disconnected`)
 * do we fall back to the caller's newest move, which surfaces that archived
 * truth.
 */
async function requireCallerMove(
	ctx: MutationCtx
): Promise<{ session: SessionWithRole; move: Doc<'mailboxMoves'> }> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session || !session.role) throwUnauthenticated();
	const resolved = await getCallerExternalMailbox(ctx);
	const move = resolved
		? await getMoveForAccount(ctx, resolved.account._id)
		: await getLatestCallerMove(ctx, session.userId);
	if (!move) throwNotFound('Mailbox move');
	return { session, move };
}

/** Serialize a move row for the settings surface (null when there's no move). */
function buildMovePayload(move: Doc<'mailboxMoves'> | null) {
	return move
		? {
				id: move._id,
				stage: move.stage,
				isPaused: move.isPaused,
				hostedMailboxId: move.hostedMailboxId ?? null,
				awaitingAdminProvision: move.stage === 'provisioning' && move.provisionRequestId != null,
				createdAt: move.createdAt,
				updatedAt: move.updatedAt,
				archivedAt: move.archivedAt ?? null,
			}
		: null;
}

/**
 * Everything the settings surface needs to render the move flow for the caller's
 * own mailbox: eligibility, the move's current stage/truth, and the exact MX
 * record to hand a DNS admin. Soft-auth — returns `{ eligible: false }` for an
 * anonymous caller or one with no external mailbox AND no move to show.
 *
 * A move outlives its live external mailbox: `archive` demotes the account to
 * `disconnected`, so `getCallerExternalMailbox` returns null for a completed
 * move — but the flow must keep showing its terminal (archived) truth. When the
 * live mailbox is gone we surface the move from its own row (it carries
 * `address`/`domain`), fetching `lastSyncAt` via the now-disconnected account.
 * The strict movable gate lives only in `start`, which is what may *create* a
 * move.
 */
// public: soft-auth — reads only the caller's own external mailbox + move rows.
export const moveStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const mailHost = inboundMailHost();

		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !session.role) {
			return { eligible: false as const };
		}

		// Owners/admins can provision a hosted mailbox themselves; anyone else must
		// wait for an admin to act on the request `start` raised.
		const isAdmin = hasPermission(session.role, 'organization:manage');
		// The MX target + record to publish (null host ⇒ send-only install with no
		// inbound MTA; the UI omits the guidance and the move can't complete).
		const resolved = await getCallerExternalMailbox(ctx);

		if (!resolved) {
			// No live mailbox to move. Still surface the newest completed move so the
			// archived terminal state (and its confirmation) doesn't vanish.
			const move = await getLatestCallerMove(ctx, session.userId);
			if (!move) return { eligible: false as const };
			const account = await ctx.db.get(move.accountId);
			return {
				eligible: true as const,
				address: move.address,
				domain: move.domain,
				// The mover's own last-sync truth (fail-soft: shown as-is, never assumed).
				lastSyncAt: account?.lastSyncAt ?? null,
				accountStatus: account?.status ?? ('disconnected' as const),
				canProvisionSelf: isAdmin,
				mxHost: mailHost,
				mxPriority: MX_PRIORITY,
				move: buildMovePayload(move),
			};
		}

		const { account, mailbox } = resolved;
		// Pair the move with the account it operates on — NOT the caller's oldest
		// move. A completed move on an earlier address leaves an archived row
		// forever; keying `by_account` means a freshly-connected mailbox correctly
		// shows the "start a move" pitch (null move) instead of that stale truth.
		const move = await getMoveForAccount(ctx, account._id);
		return {
			eligible: true as const,
			address: mailbox.address,
			domain: mailbox.domain,
			// The mover's own last-sync truth (fail-soft: shown as-is, never assumed).
			lastSyncAt: account.lastSyncAt ?? null,
			accountStatus: account.status,
			canProvisionSelf: isAdmin,
			mxHost: mailHost,
			mxPriority: MX_PRIORITY,
			move: buildMovePayload(move),
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
		const isAdmin = hasPermission(session.role, 'organization:manage');

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
			isPaused: false,
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
// authz: admin — the adminMutation wrapper gates hosted-mailbox creation.
export const provisionHosted = adminMutation({
	args: { moveId: v.id('mailboxMoves') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		// The wrapper already enforced the admin floor; we still need the session
		// for the acting user + org scope.
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) throwForbidden('No active organization');

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
		const { move } = await requireCallerMove(ctx);

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
			isPaused: false,
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
		const { move } = await requireCallerMove(ctx);
		if (move.stage === 'archived' || move.isPaused) {
			return { isPaused: move.isPaused };
		}
		await ctx.db.patch(move._id, { isPaused: true, updatedAt: Date.now() });
		return { isPaused: true };
	},
});

/** Resume a paused move. Idempotent. Self. */
// authz: self — resumes only the caller's own move.
export const resume = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const { move } = await requireCallerMove(ctx);
		if (!move.isPaused) {
			return { isPaused: false };
		}
		await ctx.db.patch(move._id, { isPaused: false, updatedAt: Date.now() });
		return { isPaused: false };
	},
});

/**
 * Cancel a move-in-progress — the documented rollback. Refused once `archived`
 * (that's terminal; the "undo the archive" is a separate flow). If a hosted
 * mailbox was already provisioned it's soft-deleted and pulled from the MTA
 * cache, so inbound routing falls back to the external provider once MX is
 * repointed — nothing is lost. The external account is untouched (still live and
 * syncing). Self.
 *
 * The clean rollback only holds while the hosted mailbox is still empty. Cancel
 * is allowed all through `cutover_pending`, i.e. exactly when MX may already
 * point here and real mail may have landed in the hosted mailbox. Tearing it
 * down then would orphan that mail, so we refuse and tell the user to repoint MX
 * back (or archive) first — honoring the in-flow "nothing is lost" promise.
 */
// authz: self — cancels only the caller's own move.
export const cancel = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const { session, move } = await requireCallerMove(ctx);
		if (move.stage === 'archived') {
			throwInvalidState("This move is already complete and can't be cancelled");
		}

		const now = Date.now();

		// Tear down the hosted mailbox we stood up — but only if it's still empty.
		// Once inbound mail has landed in it (MX already cut over), a soft-delete
		// would orphan real mail; refuse and point the user back at MX/archive.
		if (move.hostedMailboxId != null) {
			const hosted = await ctx.db.get(move.hostedMailboxId);
			if (hosted && hosted.status !== 'deleted') {
				const anyMessage = await ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', hosted._id))
					.first();
				if (anyMessage) {
					throwInvalidState(
						'Mail has already arrived in your Owlat mailbox. Point your MX record back at your old provider first, then archive — cancelling now would lose that mail.'
					);
				}
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
