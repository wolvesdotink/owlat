/**
 * Read-only CardDAV sync into the Postbox address book: the account a mailbox
 * connects, its state on the contacts page, the commit each sync ends with, and
 * the recurring pick-up in crons.ts.
 *
 * The network half (discovery, the sync report, the card fetches) runs in
 * `contactsCardDavActions.ts`; the request and answer formats are in
 * `contactsCardDavProtocol.ts`. Cards are written with the merge a vCard
 * import uses (`contactsMerge.ts`).
 *
 * The account belongs to the mailbox, not the member who connected it: on a
 * team inbox every member sees the book's state and may disconnect it. Nothing
 * is ever written back to the server.
 */

import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { normalizeVcardImportEntry } from '@owlat/shared/postboxVcard';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import {
	mailCardDavErrorCodeValidator,
	mailContactImportEntryValidator,
} from '../lib/validators/mailContacts';
import { throwForbidden } from '../_utils/errors';
import { postboxMutation, postboxQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { detachSyncedRow, writeAddressBookEntry } from './contactsMerge';

/** How often the recurring sync reads a connected book. */
export const CARDDAV_SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** A "Sync now" within this long of the last one is ignored. */
const SYNC_NOW_COOLDOWN_MS = 60 * 1000;
/** Accounts one cron tick hands to the sync. */
const DUE_SYNCS_PER_TICK = 25;
/** Rows one disconnect batch takes out of the book. */
const DETACH_BATCH_SIZE = 200;
/** Rows of a book one known-cards page reads. */
const KNOWN_CARDS_PAGE_LIMIT = 1_000;
/**
 * How long a sync holds its account. Longer than an action may run (ten
 * minutes), so a live sync never loses its claim, and a sync that died
 * without releasing it blocks the account only this long.
 */
export const CARDDAV_SYNC_CLAIM_MS = 15 * 60 * 1000;

async function accountOfMailbox(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailCardDavAccounts'> | null> {
	return ctx.db
		.query('mailCardDavAccounts')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
}

/** The connected book of a mailbox and how its last sync went; never the password. */
// authz: mailbox access via requireMailboxAccess; org membership via the postbox builder.
export const getForMailbox = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const account = await accountOfMailbox(ctx, args.mailboxId);
		if (!account) return null;
		return {
			_id: account._id,
			serverUrl: account.serverUrl,
			addressBookName: account.addressBookName,
			username: account.username,
			status: account.status,
			lastSyncedAt: account.lastSyncedAt,
			lastErrorCode: account.lastErrorCode,
			isTruncated: account.isTruncated === true,
		};
	},
});

/** Ask for a sync of the mailbox's book now, instead of at the next hourly pick-up. */
// authz: mailbox access via requireMailboxAccess; org membership via the postbox builder.
export const syncNow = postboxMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const account = await accountOfMailbox(ctx, args.mailboxId);
		if (!account) return { isScheduled: false };
		const now = Date.now();
		if (account.syncRequestedAt && now - account.syncRequestedAt < SYNC_NOW_COOLDOWN_MS) {
			return { isScheduled: false };
		}
		await ctx.db.patch(account._id, {
			syncRequestedAt: now,
			nextSyncAt: now + CARDDAV_SYNC_INTERVAL_MS,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.mail.contactsCardDavActions._sync, {
			accountId: account._id,
		});
		return { isScheduled: true };
	},
});

/**
 * Disconnect the mailbox's book. The account and its sealed password go at
 * once; the rows the sync inserted follow in batches (`_detachAccountRows`).
 */
// authz: mailbox access via requireMailboxAccess; org membership via the postbox builder.
export const disconnect = postboxMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const account = await accountOfMailbox(ctx, args.mailboxId);
		if (!account) return;
		await ctx.db.delete(account._id);
		await ctx.scheduler.runAfter(0, internal.mail.contactsCardDav._detachAccountRows, {
			accountId: account._id,
		});
	},
});

/** Take one batch of a disconnected account's rows out of the book, then the next. */
export const _detachAccountRows = internalMutation({
	args: { accountId: v.id('mailCardDavAccounts') },
	handler: async (ctx, args) => {
		// Each detached row leaves the index, so the next batch starts at the front.
		const rows = await ctx.db
			.query('mailContacts')
			.withIndex('by_carddav_account_and_href', (q) =>
				q.eq('cardDavSource.accountId', args.accountId)
			)
			.take(DETACH_BATCH_SIZE);
		for (const row of rows) await detachSyncedRow(ctx, row);
		if (rows.length === DETACH_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.mail.contactsCardDav._detachAccountRows, args);
		}
	},
});

/** The connect action's access check, before it contacts the server. */
export const _canConnect = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return { ok: false as const, reason: 'forbidden' as const };
		if (await accountOfMailbox(ctx, args.mailboxId)) {
			return { ok: false as const, reason: 'already_connected' as const };
		}
		return { ok: true as const };
	},
});

/**
 * The connect action's commit: the discovered book and the sealed password.
 * Access and the one-book-per-mailbox rule are checked again, because the
 * discovery ran in between.
 */
export const _insertAccount = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		serverUrl: v.string(),
		addressBookUrl: v.string(),
		addressBookName: v.optional(v.string()),
		username: v.string(),
		secretCiphertext: v.string(),
		secretIv: v.string(),
		secretAuthTag: v.string(),
		secretEnvelopeVersion: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return { ok: false as const, reason: 'forbidden' as const };
		if (await accountOfMailbox(ctx, args.mailboxId)) {
			return { ok: false as const, reason: 'already_connected' as const };
		}
		const now = Date.now();
		const accountId = await ctx.db.insert('mailCardDavAccounts', {
			...args,
			status: 'pending',
			nextSyncAt: now + CARDDAV_SYNC_INTERVAL_MS,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.mail.contactsCardDavActions._sync, { accountId });
		return { ok: true as const };
	},
});

/**
 * Claim the account for one sync run and return it, sealed password included
 * (internal only). Null while another run's claim is live: that run already
 * reads the book, and two runs interleaving their commits could bring back a
 * card the other removed. A claim lapses after `CARDDAV_SYNC_CLAIM_MS`.
 */
export const _claimSync = internalMutation({
	args: { accountId: v.id('mailCardDavAccounts'), runToken: v.string() },
	handler: async (ctx, args): Promise<Doc<'mailCardDavAccounts'> | null> => {
		const account = await ctx.db.get(args.accountId);
		if (!account) return null;
		const now = Date.now();
		if (account.syncRunToken && (account.syncRunExpiresAt ?? 0) > now) return null;
		const claim = { syncRunToken: args.runToken, syncRunExpiresAt: now + CARDDAV_SYNC_CLAIM_MS };
		await ctx.db.patch(account._id, claim);
		return { ...account, ...claim };
	},
});

/** Whether `runToken` still holds the account; false once it is gone or claimed by another run. */
function isHeldBy(
	account: Doc<'mailCardDavAccounts'> | null,
	runToken: string
): account is Doc<'mailCardDavAccounts'> {
	return account !== null && account.syncRunToken === runToken;
}

/** One page of the cards the book already holds, with the etag each was written at. */
export const _knownCards = internalQuery({
	args: { accountId: v.id('mailCardDavAccounts'), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query('mailContacts')
			.withIndex('by_carddav_account_and_href', (q) =>
				q.eq('cardDavSource.accountId', args.accountId)
			)
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, KNOWN_CARDS_PAGE_LIMIT),
			});
		return {
			isDone: result.isDone,
			continueCursor: result.continueCursor,
			page: result.page.flatMap((row) =>
				row.cardDavSource ? [{ href: row.cardDavSource.href, etag: row.cardDavSource.etag }] : []
			),
		};
	},
});

const syncedEntryValidator = v.object({
	entry: mailContactImportEntryValidator,
	photoStorageId: v.optional(v.id('_storage')),
});

/**
 * Write one page of a sync's changes: changed cards with their entries, and
 * cards the server no longer has. Idempotent, so a sync that fails between
 * pages leaves a book the next sync finishes. Pictures the rows do not take
 * are deleted here, as are all of them when the run no longer holds the
 * account (disconnected, or claimed by a later run after this one's lapsed).
 */
export const _applyChanges = internalMutation({
	args: {
		accountId: v.id('mailCardDavAccounts'),
		runToken: v.string(),
		changed: v.array(
			v.object({ href: v.string(), etag: v.string(), entries: v.array(syncedEntryValidator) })
		),
		removedHrefs: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const unusedPhotos: Array<Id<'_storage'>> = [];
		const account = await ctx.db.get(args.accountId);
		if (!isHeldBy(account, args.runToken)) {
			for (const card of args.changed) {
				for (const { photoStorageId } of card.entries) {
					if (photoStorageId) unusedPhotos.push(photoStorageId);
				}
			}
			await deletePhotos(ctx, unusedPhotos);
			return { isStopped: true };
		}
		const now = Date.now();
		for (const card of args.changed) {
			const emails = new Set<string>();
			for (const { entry: raw, photoStorageId } of card.entries) {
				const entry = normalizeVcardImportEntry(raw);
				if (!entry) {
					if (photoStorageId) unusedPhotos.push(photoStorageId);
					continue;
				}
				emails.add(entry.email);
				const written = await writeAddressBookEntry(
					ctx,
					account.mailboxId,
					entry,
					{ kind: 'carddav', accountId: account._id, href: card.href, etag: card.etag },
					now,
					photoStorageId
				);
				if (photoStorageId && !written.isPhotoUsed) unusedPhotos.push(photoStorageId);
			}
			// An address the card no longer lists leaves the book like a removed card.
			for (const row of await rowsOfCard(ctx, account._id, card.href)) {
				if (!emails.has(row.email)) await detachSyncedRow(ctx, row);
			}
		}
		for (const href of args.removedHrefs) {
			for (const row of await rowsOfCard(ctx, account._id, href)) {
				await detachSyncedRow(ctx, row);
			}
		}
		await deletePhotos(ctx, unusedPhotos);
		return { isStopped: false };
	},
});

/** How a sync ended: the new sync state, or why it failed. Releases the run's claim. */
export const _finishSync = internalMutation({
	args: {
		accountId: v.id('mailCardDavAccounts'),
		runToken: v.string(),
		outcome: v.union(
			v.object({
				ok: v.literal(true),
				syncToken: v.optional(v.string()),
				ctag: v.optional(v.string()),
				isTruncated: v.boolean(),
			}),
			v.object({ ok: v.literal(false), errorCode: mailCardDavErrorCodeValidator })
		),
	},
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		// A run that lost its claim leaves the state to the run that holds it.
		if (!isHeldBy(account, args.runToken)) return;
		const now = Date.now();
		const release = { syncRunToken: undefined, syncRunExpiresAt: undefined };
		if (args.outcome.ok) {
			await ctx.db.patch(account._id, {
				...release,
				status: 'ok',
				syncToken: args.outcome.syncToken,
				ctag: args.outcome.ctag,
				isTruncated: args.outcome.isTruncated,
				lastSyncedAt: now,
				lastErrorCode: undefined,
				updatedAt: now,
			});
			return;
		}
		await ctx.db.patch(account._id, {
			...release,
			status: 'error',
			lastErrorCode: args.outcome.errorCode,
			updatedAt: now,
		});
	},
});

/**
 * The recurring pick-up (crons.ts): hand every account whose next sync is due
 * to the sync, and move its next sync an interval on first, so a sync that
 * fails or never finishes is tried again an interval later, not every tick.
 */
export const _scheduleDueSyncs = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const due = await ctx.db
			.query('mailCardDavAccounts')
			.withIndex('by_next_sync', (q) => q.lte('nextSyncAt', now))
			.take(DUE_SYNCS_PER_TICK);
		for (const account of due) {
			await ctx.db.patch(account._id, { nextSyncAt: now + CARDDAV_SYNC_INTERVAL_MS });
			await ctx.scheduler.runAfter(0, internal.mail.contactsCardDavActions._sync, {
				accountId: account._id,
			});
		}
	},
});

async function rowsOfCard(
	ctx: MutationCtx,
	accountId: Id<'mailCardDavAccounts'>,
	href: string
): Promise<Array<Doc<'mailContacts'>>> {
	return ctx.db
		.query('mailContacts')
		.withIndex('by_carddav_account_and_href', (q) =>
			q.eq('cardDavSource.accountId', accountId).eq('cardDavSource.href', href)
		)
		.collect(); // bounded: one card's addresses, at most VCARD_MAX_EMAILS_PER_CARD rows
}

async function deletePhotos(ctx: MutationCtx, storageIds: Array<Id<'_storage'>>): Promise<void> {
	for (const storageId of storageIds) {
		await deleteBlobQuietly(ctx.storage, storageId, '[carddav sync]');
	}
}
