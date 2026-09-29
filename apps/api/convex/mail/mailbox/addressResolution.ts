/**
 * Which mailbox rows sit on an address, and what each of those rows means.
 *
 * Every `mailboxes` read through the `by_address` index goes through this
 * module (a source-scan test, `mail/__tests__/mailboxAddressReadsGuard.test.ts`,
 * refuses a new one elsewhere). One address can carry more than one row:
 *
 *   - A completed move (`mail/mailboxMove.ts`) leaves the old external mailbox
 *     active as a read-only archive beside its hosted successor.
 *   - A disconnected personal external account leaves its mailbox soft-deleted
 *     (`status: 'deleted'`, `kind: 'external'`) so a reconnect can re-open it
 *     with the mail it kept (`external/personalAccount.ts`).
 *   - A removed hosted mailbox stays as a soft-deleted row.
 *
 * So "the row on this address" is never a bare `.first()`, which returns the
 * oldest row. Callers pick the question they are asking:
 *
 *   - `resolveDeliverableMailbox`: which mailbox receives mail for, and
 *     authenticates, this address?
 *   - `findAddressClaim`: may a new mailbox be provisioned here?
 *   - `listMailboxesOnAddress`: every row, for callers with a narrower question.
 *
 * A leaf module: it imports only generated types, never anything from the mail
 * domain, so any mail module (including the external-account teardown that
 * `mailbox/identity.ts` itself imports) can depend on it without closing an
 * import cycle.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';

/**
 * Every `mailboxes` row on `address`, oldest first. `address` must already be
 * canonical (`extractEmail` from `lib/emailAddress`).
 */
export async function listMailboxesOnAddress(
	ctx: QueryCtx | MutationCtx,
	address: string
): Promise<Doc<'mailboxes'>[]> {
	return await ctx.db
		.query('mailboxes')
		.withIndex('by_address', (q) => q.eq('address', address))
		.collect(); // bounded: an external archive + its hosted successor, plus soft-deleted remnants
}

/**
 * Resolve the single authoritative mailbox that owns an address for inbound
 * delivery and IMAP/SMTP auth. A "move" (mail/mailboxMove.ts) intentionally
 * leaves TWO active rows on one address: the old external one — now a read-only
 * archive, `kind='external'` — and the new live `kind='hosted'` mailbox. A bare
 * `by_address` + `.first()` returns the OLDEST row, i.e. the archive, which
 * would silently swallow all post-cutover inbound mail. Prefer the non-external
 * (hosted/local) row so the live mailbox always wins; fall back to the sole
 * active row otherwise. Returns `null` when no active mailbox claims the address.
 */
export async function resolveDeliverableMailbox(
	ctx: QueryCtx | MutationCtx,
	address: string
): Promise<Doc<'mailboxes'> | null> {
	const rows = await listMailboxesOnAddress(ctx, address);
	const active = rows.filter((m) => m.status === 'active');
	if (active.length === 0) return null;
	// The hosted/local mailbox is authoritative on the MTA; the external row is a
	// read-only archive that must never receive new mail.
	return active.find((m) => m.kind !== 'external') ?? active[0] ?? null;
}

/**
 * Does this row stop a new mailbox from being provisioned on its address?
 *
 * Every row does, whatever its status, except a soft-deleted EXTERNAL mailbox.
 * A suspended mailbox is paused, not gone, and a soft-deleted hosted one keeps
 * its mail and its decrypt-only sealing keys, so both keep the address. A soft-deleted
 * external mailbox is what a disconnect (or an admin retiring the account)
 * leaves behind: the owner's reconnect re-opens it through
 * `findRetainedPersonalAccount` rather than provisioning beside it, and an
 * admin-retired one is explicitly allowed a fresh mailbox on the same address.
 */
function claimsAddress(mailbox: Doc<'mailboxes'>): boolean {
	return !(mailbox.status === 'deleted' && mailbox.kind === 'external');
}

/**
 * The first row that claims `address` under {@link claimsAddress}, or null when
 * a new mailbox may be provisioned there. The one "is this address taken" check
 * behind hosted create, reservations, aliases and every external connect.
 * `mail/mailboxMove.ts` provisions its hosted mailbox beside the live external
 * row on purpose and does not ask.
 */
export async function findAddressClaim(
	ctx: QueryCtx | MutationCtx,
	address: string
): Promise<Doc<'mailboxes'> | null> {
	const rows = await listMailboxesOnAddress(ctx, address);
	return rows.find(claimsAddress) ?? null;
}
