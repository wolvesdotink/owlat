/**
 * Taking a connected external mailbox back apart — the shared half of every
 * path that stops syncing one.
 *
 * Four callers reach for this and must agree on what "disconnected" means:
 * the personal `disconnect` / `purge` (`mail/external/accounts.ts`), the seed
 * mailbox's `disconnectSeed` (`mail/external/accountsSeed.ts`), and the team
 * inbox's `purgeShared` (`mail/external/sharedInbox.ts`). Splitting the shared
 * steps out of `accounts.ts` keeps that file under the size cap and, more to the
 * point, makes the guarantees one edit instead of four:
 *
 *   - the stored password is GONE. A member who disconnects their mailbox means
 *     "forget my password", not "keep it encrypted at rest indefinitely" — only
 *     a full purge used to remove it. The sealed envelope is dropped from the
 *     row, which is why those four fields are optional in the schema.
 *   - an in-flight migration is cancelled. The worker stops at a disconnected
 *     account (`listConnectableAccounts` excludes it), so a migration left
 *     `importing` would report a running import forever — and it would come
 *     back to life the next time the same account is reconnected.
 *   - the mailbox is hidden and the account is marked `disconnected`, which is
 *     what actually stops the mail-sync worker.
 *
 * The cascade delete (`_purgeChunk`) lives here for the same reason: it is the
 * same teardown carried all the way through to the data.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { removeMessageAttachments } from '../attachmentIndex';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { cancelActiveMigrationForAccount } from './accountShared';
import type { Doc } from '../../_generated/dataModel';

/** Messages deleted per purge step; the step re-schedules itself while more remain. */
const PURGE_CHUNK = 200;

/**
 * WHO ended the connection. The three answers differ in what else has to happen,
 * and every one of those differences used to be a separate call site getting it
 * subtly wrong:
 *
 *   'member' — the owner disconnected (or retired a seed): hide the mailbox,
 *              stop a running import.
 *   'admin'  — an admin removed the mailbox (`mailbox/identity.ts`): the same,
 *              plus a mark that keeps a later reconnect from re-attaching it.
 *   'move'   — "move my mailbox here" archived the source: the mailbox row stays
 *              ACTIVE so the moved history keeps rendering, and a migration is
 *              left alone — the import already landed in this mailbox and an AI
 *              sweep still reading it has real work to finish.
 */
export type DisconnectReason = 'member' | 'admin' | 'move';

/**
 * Stop syncing an external account: forget the password, mark the account
 * `disconnected`, and — depending on who ended it — hide the mailbox and cancel
 * a running import. Writes the `external_account.disconnected` mailbox audit
 * entry the trail is read by.
 */
export async function stopExternalAccountSync(
	ctx: MutationCtx,
	account: Doc<'externalMailAccounts'>,
	options: { now: number; reason: DisconnectReason; details?: string }
): Promise<{ cancelledMigration: boolean }> {
	const { now, reason } = options;
	await ctx.db.patch(account._id, {
		status: 'disconnected',
		updatedAt: now,
		...(reason === 'admin' ? { adminRetiredAt: now } : {}),
		// The encrypted envelope goes with the connection. Reconnecting asks for the
		// password again (the connect form never pre-fills one), so nothing
		// downstream needs it, and `getCredentialsForWorker` then hands the worker
		// nothing for this row.
		secretCiphertext: undefined,
		secretIv: undefined,
		secretAuthTag: undefined,
		secretEnvelopeVersion: undefined,
	});
	// `cancelActiveMigrationForAccount` is the quiet half (no audit row) — the
	// audited `migration.cancel` is for a member cancelling an import they meant
	// to run. Here the mailbox is going away in the same transaction, and this
	// teardown's own `external_account.disconnected` entry below is the trail. The
	// timing matters more than the wording: `getBackfillWork` reports inactive on
	// the worker's very next poll, so a mid-walk backfill stops fetching straight
	// away instead of writing into a mailbox that is draining.
	const cancelledMigration =
		reason === 'move' ? false : await cancelActiveMigrationForAccount(ctx, account._id);
	if (reason !== 'move') {
		// Hide from the inbox UI (requireMailboxAccess refuses non-active rows).
		await ctx.db.patch(account.mailboxId, { status: 'deleted', updatedAt: now });
	}
	await ctx.db.insert('mailAuditLog', {
		mailboxId: account.mailboxId,
		event: 'external_account.disconnected',
		...(options.details ? { details: options.details } : {}),
		occurredAt: now,
	});
	if (cancelledMigration) {
		await ctx.db.insert('mailAuditLog', {
			mailboxId: account.mailboxId,
			event: 'migration.cancelled',
			details: 'external account disconnected',
			occurredAt: now,
		});
	}
	return { cancelledMigration };
}

/**
 * Everything a purge does BEFORE it starts deleting: stop the sync (so the
 * worker isn't writing into a draining mailbox) and stop publishing the
 * address's sealing key. Shared by the personal `purge` and the team inbox's
 * `purgeShared` so the two can't drift on it.
 *
 * The caller then schedules `_purgeChunk` itself — one line, and it keeps each
 * purge path naming the cascade it kicks off.
 */
export async function prepareAccountPurge(
	ctx: MutationCtx,
	account: Doc<'externalMailAccounts'>,
	now: number
): Promise<void> {
	await stopExternalAccountSync(ctx, account, { now, reason: 'member' });
	// The rows outlive this mutation by the whole length of the chunked delete, so
	// say out loud that they are draining: a purging account is not a disconnected
	// one with its mail kept, and must not be offered back to its owner as one.
	await ctx.db.patch(account._id, { purgeStartedAt: now });
	const mailbox = await ctx.db.get(account.mailboxId);
	if (!mailbox) return;
	// Sealed Mail: the address keys were minted when the mailbox was provisioned,
	// so a purge that left them published would keep other instances sealing mail
	// to an address this deployment no longer holds a mailbox for. Retained
	// decrypt-only, exactly as `mailbox/identity.ts`'s `remove` leaves them.
	//
	// Unless the address is still live somewhere else. `deactivateAddressKeys` is
	// keyed by ADDRESS, and a completed move leaves the archive being purged here
	// sharing its address with the hosted mailbox that succeeded it — revoking
	// there would stop peers sealing mail to a mailbox that is still receiving it.
	// (Read inline rather than through `mailbox/identity.ts`'s resolver: that
	// module already imports this one, and the question here is narrower anyway.)
	const onThisAddress = await ctx.db
		.query('mailboxes')
		.withIndex('by_address', (q) => q.eq('address', mailbox.address))
		.collect(); // bounded: at most an external archive + its hosted successor
	const addressGoesAway = !onThisAddress.some(
		(other) => other._id !== mailbox._id && other.status === 'active'
	);
	if (addressGoesAway && (await isFeatureEnabled(ctx, 'sealedMail'))) {
		await ctx.scheduler.runAfter(0, internal.e2ee.lifecycle.deactivateAddressKeys, {
			address: mailbox.address,
		});
	}
}

/**
 * One purge step: delete up to PURGE_CHUNK messages (and their storage blobs),
 * re-scheduling itself while messages remain. Once messages are drained, delete
 * the remaining per-mailbox rows and the account/mailbox themselves.
 *
 * The last step also clears what would otherwise outlive the mailbox: the app
 * passwords that authenticate a mail client INTO it (a credential for a mailbox
 * that no longer exists), the membership rows, and the migration records that
 * point at the account row about to be deleted.
 */
export const _purgeChunk = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		mailboxId: v.id('mailboxes'),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.take(PURGE_CHUNK);
		for (const m of messages) {
			await ctx.storage.delete(m.rawStorageId).catch(() => undefined);
			if (m.textBodyStorageId) await ctx.storage.delete(m.textBodyStorageId).catch(() => undefined);
			if (m.htmlBodyStorageId) await ctx.storage.delete(m.htmlBodyStorageId).catch(() => undefined);
			await removeMessageAttachments(ctx, m._id);
			await ctx.db.delete(m._id);
		}
		if (messages.length === PURGE_CHUNK) {
			await ctx.scheduler.runAfter(0, internal.mail.external.accountTeardown._purgeChunk, args);
			return;
		}

		// Messages drained — delete the rest. Each set is small per mailbox.
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox folder set
		for (const f of folders) await ctx.db.delete(f._id);

		// Threads are per-conversation, not per-message, but a long-lived mailbox can
		// still hold more of them than one mutation may delete. Drain them a page at
		// a time and come back, rather than taking a fixed ceiling and leaving the
		// remainder orphaned behind a mailbox row that is about to disappear.
		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
			.take(PURGE_CHUNK);
		for (const t of threads) await ctx.db.delete(t._id);
		if (threads.length === PURGE_CHUNK) {
			await ctx.scheduler.runAfter(0, internal.mail.external.accountTeardown._purgeChunk, args);
			return;
		}

		const drafts = await ctx.db
			.query('mailDrafts')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox drafts
		for (const d of drafts) await ctx.db.delete(d._id);

		const labels = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: per-mailbox labels
		for (const l of labels) await ctx.db.delete(l._id);

		// App passwords are live credentials for THIS mailbox over IMAP/SMTP —
		// leaving them behind would keep a login alive for a mailbox that no longer
		// exists, and hand the next mailbox on the same address a stranger's client.
		const appPasswords = await ctx.db
			.query('mailAppPasswords')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: a person's mail clients (a handful)
		for (const p of appPasswords) await ctx.db.delete(p._id);

		// The owner membership (and, for a team inbox, its roster) — access rows
		// for a mailbox that is about to stop existing.
		const members = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's roster
		for (const member of members) await ctx.db.delete(member._id);

		const syncRows = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: per-account folder cursors (≤ a handful)
		for (const sr of syncRows) await ctx.db.delete(sr._id);

		// The account's import jobs (personal migrations AND team-inbox ones) point
		// at a row that is about to stop existing — drop them. Deleting is enough to
		// stop an IN-FLIGHT import: `getBackfillWork` finds no row and reports
		// inactive, and a still-in-flight batch's `recordBackfillProgress` /
		// `completeBackfillImport` load the migration by id and bail on null.
		const migrations = await ctx.db
			.query('mailboxMigrations')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: a handful of import jobs per account
		for (const m of migrations) await ctx.db.delete(m._id);

		// A staged "move my mailbox here" job points at this account — drop it too,
		// so its move row (and the terminal truth getLatestCallerMove surfaces from
		// it) doesn't linger as the newest move after the account is gone.
		const moves = await ctx.db
			.query('mailboxMoves')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: ≤ 1 move per account
		for (const mv of moves) await ctx.db.delete(mv._id);

		await ctx.db.delete(args.accountId);
		await ctx.db.delete(args.mailboxId);
	},
});
