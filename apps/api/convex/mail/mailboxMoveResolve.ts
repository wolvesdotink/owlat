/**
 * Resolution helpers for the "move my mailbox here" flow (piece c5).
 *
 * Split out of `mailboxMove.ts` (which holds the Convex queries/mutations) to
 * keep each file focused and under the file-size cap. No Convex functions live
 * here — these are plain helpers the `mailboxMove` handlers compose:
 *
 *   getCallerExternalMailbox  — the caller's LIVE movable mailbox (or null)
 *   getMoveForAccount         — the move paired to a specific account (by_account)
 *   getLatestCallerMove       — the caller's newest move (terminal-truth fallback)
 *   requireCallerMove         — auth + load the caller's own move, or throw
 *   buildMovePayload          — serialize a move row for the settings surface
 *
 * The account resolution deliberately uses `getLiveExternalAccountForUser`
 * (state-based, not oldest-row): a completed move leaves a `disconnected`
 * archive row that coexists with a freshly-connected account, and `by_user` +
 * `.first()` would return the stale archive.
 */

import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { getLiveExternalAccountForUser } from './externalAccounts';
import { throwNotFound, throwUnauthenticated } from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

type SessionWithRole = NonNullable<Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>>;
/** A session narrowed to a real org member — `role` is guaranteed non-null. */
export type MoverSession = SessionWithRole & { role: NonNullable<SessionWithRole['role']> };

/**
 * Resolve the caller's own movable external mailbox — the thing a move operates
 * on. Returns `null` when the caller is anonymous/role-less, has no LIVE external
 * account, or the account's mailbox isn't `active`. Resolves the account by
 * state (`getLiveExternalAccountForUser`) so a completed move's `disconnected`
 * archive row never masks a freshly-connected account. Each caller picks its own
 * failure mode from the `null`.
 */
export async function getCallerExternalMailbox(ctx: QueryCtx | MutationCtx): Promise<{
	session: MoverSession;
	account: Doc<'externalMailAccounts'>;
	mailbox: Doc<'mailboxes'>;
} | null> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session || !session.role) return null;
	const account = await getLiveExternalAccountForUser(ctx, session.userId);
	// No live account ⇒ nothing to move (a disconnected archive is not movable).
	if (!account) return null;
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
export async function getMoveForAccount(
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
export async function getLatestCallerMove(
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
export async function requireCallerMove(
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
export function buildMovePayload(move: Doc<'mailboxMoves'> | null) {
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
